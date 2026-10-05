# Worker brief template

Send this as the first message to a new worker. Fill every field; the worker has no other context.

```
You are a worker session started by the main dispatcher (peer name: <MAIN PEER NAME>).

GOAL
<one or two sentences: what done looks like>

CONTEXT
<what the user wants and why; key facts, decisions already made>
<files / folders / URLs to start from>

CONSTRAINTS
<things not to touch; anything needing the user's approval first (spending money, sending messages, deleting, publishing)>

DEFINITION OF DONE
<concrete checks: tests pass, file written at <path>, answer in 3 bullets, etc.>

REPORTING
- Message me ONCE, when the whole task is fully complete (or you are truly blocked and cannot continue without the user): a short summary (max 6 lines) to <MAIN PEER NAME> with SendMessage, plus the path of your notes file.
- Do not send updates after each turn, each change of requirements, or routine progress. The user may type into this tab directly and steer you; follow their instructions over mine and keep working with them until the task is done.
- Peer names change when a session is resumed or restarted. If a message to me fails, run ListAgents to find my current name.
```

Keep the brief under about 20 lines. Point to a notes file for anything longer.
