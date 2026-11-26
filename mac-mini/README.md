# Mac mini: run local AI models 24/7

`setup.sh` turns a Mac mini into an always-on AI box. It keeps the Mac awake, starts it again by itself after a power cut, lets you control it without a screen, and runs open models (Qwen, Gemma, Llama) through [Ollama](https://ollama.com).

## Before you start (on the Mac mini, with a screen plugged in once)

1. **Use a normal account with automatic login.** Don't use a guest account: macOS wipes guest accounts when you log out, so your models and settings would be lost.
2. **Turn off FileVault:** System Settings → Privacy & Security → FileVault. If FileVault is on, the Mac stops at a password screen after every power cut. The tradeoff: if someone steals the Mac, they can read its disk.
3. **Turn on automatic login:** System Settings → Users & Groups → "Automatically log in as" → your account.
4. **Turn on Screen Sharing** (optional): System Settings → General → Sharing → Screen Sharing.
5. **Install Homebrew** from [brew.sh](https://brew.sh) (paste the command shown there into Terminal).

## Run the script

Get the script onto the Mac mini. You can either clone the repo:

```bash
git clone https://github.com/CommandCenter12/open-verse-ai.git ~/open-verse-ai
```

or AirDrop `setup.sh` to the Mac mini. Then run it:

```bash
bash ~/open-verse-ai/mac-mini/setup.sh
```

The script asks before every change. It asks for your password only when macOS needs it (`sudo`), and it never saves your password.

| Option | What it does |
| --- | --- |
| `--check` | Shows what is and isn't set up. Changes nothing. |
| `--yes` | Makes every change without asking (macOS still asks for your password). |

## What it sets

- **Power:** the Mac never sleeps, starts automatically after a power failure, wakes when the network needs it, and restarts if it freezes.
- **Remote Login (SSH):** lets you control the Mac from your MacBook with `ssh you@<name>.local`.
- **Ollama:** installs it, starts it at every login, and downloads models that fit your RAM:

  | RAM | Models |
  | --- | --- |
  | 8 GB | qwen3:4b, llama3.2:3b |
  | 16 GB | qwen3:8b, gemma3:4b |
  | 32 GB or more | qwen3:14b, gemma3:12b, llama3.1:8b |

  Ollama only listens on the Mac itself (127.0.0.1:11434), not the internet.
- **Command Center heartbeat** (optional): set up only if `~/trading-bot` is on the Mac.
- **Trading bot** (optional): if `~/trading-bot` is on the Mac, runs its own `setup-mac-mini.sh --bot-only` (Python environment, phone approvals, the 5-minute paper-trader job and its self-tests). Copy that folder from your MacBook; it holds private keys, so it is never in GitHub.

## Test it

1. Unplug the power.
2. Plug it back in and wait about 2 minutes.
3. From your MacBook, run:

```bash
ssh you@your-mac-mini.local "ollama list"
```

If you see your models, it works.
