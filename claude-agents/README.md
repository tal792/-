# צוות סוכני AI לפיתוח

| סוכן | מודל | מה הוא עושה |
|---|---|---|
| `project-manager` | sonnet | מתכנן ומפרק משימות. קריאה בלבד |
| `developer` | sonnet | כותב קוד ב-worktree וב-branch נפרדים. בלי push או deploy |
| `qa-tester` | haiku | בודק ומתקן תקלות קטנות ב-worktree נפרד |
| `security-reviewer` | sonnet | סקירת אבטחה. קריאה בלבד |
| `inbox-cleaner` | haiku | מנקה ספאם וזבל מ-Gmail. ארכוב ותוויות, בלי מחיקה. דורש חיבור Gmail |

## התקנה במחשב שלך

```bash
mkdir -p ~/.claude/agents
cp claude-agents/agents/*.md ~/.claude/agents/
# חסימות והרשאות. אם כבר יש לך ~/.claude/settings.json, מזג ידנית את בלוק "permissions"
cp -n claude-agents/settings.json ~/.claude/settings.json
```

## שימוש

- "תשתמש ב-project-manager כדי לתכנן ..."
- "@developer תתקן את ..."
- למשימה קשה: "תריץ את developer עם opus"
- `/agents` מציג ומנהל את הסוכנים
