# smart-photo-frame

> Multi-model agentic development pipeline project.

## Run the pipeline

```bash
cd /home/nsisong/ai-workspace/projects/smart-photo-frame
python scripts/run.py "Describe your task here"
```

## Pipeline stages

| Stage | Model            | Role                          |
|-------|------------------|-------------------------------|
| 1     | Claude Opus 4.6  | Initial implementation        |
| 2     | GPT-5.4          | Code quality & documentation  |
| 3     | Gemini 2.5 Flash | Security & correctness audit  |
| 4     | Claude Opus 4.6  | Final synthesis & corrections |

## Tip: large tasks

For tasks with multiple files (>3KB of instructions), save the task to a
.sh script file and run it rather than pasting directly into the terminal.

```bash
bash ~/my-stage-task.sh
```
