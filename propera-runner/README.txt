Propera Runner - Local UI for chaosRunner.js
============================================

Prerequisites
-------------
- Node.js installed and on your PATH (node and npm available from command line).

How to run
----------
- Double-click runner.bat (Windows).
- A console window will open and a browser tab will open automatically to the Runner UI (http://localhost:3799/ or next free port).
- Keep the console window open while using the UI; closing it stops the server.

Where output lives
------------------
- Chaos run artifacts (run_*.json and run_*.txt) are written to:
    ..\runs\
  (the "runs" folder next to the "propera-runner" folder, i.e. same level as chaosRunner.js).

Troubleshooting
---------------
- If the port (3799) is busy, the server tries the next port in the range 3799-3805. Check the console message for the actual URL.
- If the browser does not open, open it manually and go to http://localhost:3799/ (or the port shown in the console).
- If "No runs yet" appears, run chaosRunner once from the UI (click Run) or ensure ..\runs\ exists and contains run_*.json from a previous chaos run.
