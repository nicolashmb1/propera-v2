-- Atomic proposal-state transition for Jarvis operator threads (spine layer 2/3).
-- Closes the multi-instance double-commit hole: the confirm "claim"
-- (awaiting_confirm -> executing) must win under a row lock so only one caller
-- across V2 instances proceeds to brain commit. Read-modify-write on the
-- pending_proposals jsonb array could not guarantee that.
--
-- Compare-and-swap by proposal_id: flip state only when the current state is in
-- p_from_states; otherwise no-op and report the current state so the caller can
-- decide (already_committed / in_flight / not_awaiting). Safe re-run.
--
-- JS caller: src/dal/jarvisOperatorThreads.js `tryClaimProposalForCommit`
-- (falls back to legacy read-modify-write when this function is absent).

create or replace function public.jarvis_transition_proposal(
  p_thread_id text,
  p_proposal_id text,
  p_from_states text[],
  p_to_state text,
  p_last_receipt jsonb default null,
  p_status text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jarvis_operator_threads%rowtype;
  v_pending jsonb;
  v_idx int;
  v_elem jsonb;
  v_cur text;
  v_applied boolean := false;
begin
  -- Row lock serializes concurrent claimers on the same thread.
  select * into v_row
    from public.jarvis_operator_threads
    where thread_id = p_thread_id
    for update;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  v_pending := coalesce(v_row.pending_proposals, '[]'::jsonb);

  select (e.ord - 1), e.val
    into v_idx, v_elem
    from jsonb_array_elements(v_pending) with ordinality as e(val, ord)
    where e.val->>'proposal_id' = p_proposal_id
    limit 1;

  if v_idx is null then
    return jsonb_build_object(
      'found', true,
      'present', false,
      'thread', row_to_json(v_row)
    );
  end if;

  v_cur := v_elem->>'state';

  if v_cur = any(p_from_states) then
    v_pending := jsonb_set(
      v_pending,
      array[v_idx::text, 'state'],
      to_jsonb(p_to_state),
      false
    );
    update public.jarvis_operator_threads
      set pending_proposals = v_pending,
          last_receipt = coalesce(p_last_receipt, last_receipt),
          status = coalesce(p_status, status),
          updated_at = now()
      where thread_id = p_thread_id
      returning * into v_row;
    v_applied := true;
    v_cur := p_to_state;
  end if;

  return jsonb_build_object(
    'found', true,
    'present', true,
    'applied', v_applied,
    'current_state', v_cur,
    'thread', row_to_json(v_row)
  );
end;
$$;

grant execute on function public.jarvis_transition_proposal(
  text, text, text[], text, jsonb, text
) to authenticated, service_role;

comment on function public.jarvis_transition_proposal(text, text, text[], text, jsonb, text) is
  'Atomic compare-and-swap of one pending_proposals[].state by proposal_id under a row lock. Used by the Jarvis confirm claim (awaiting_confirm -> executing) to prevent double brain commit across instances.';
