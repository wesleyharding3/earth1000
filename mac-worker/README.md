# Earth00 video worker (Mac side)

Opportunistic video renderer that lives on the admin's Mac. Polls Render's queue every minute; when threads are waiting on videos, opens earth00.com in headless Chromium (with real Mac GPU), records the cinematic globe-flyby clip via the production app's `__shareGlobeClip`, and uploads the MP4 back to Render.

## Why

Render has no GPU. SwiftShader (software WebGL) chokes on the production globe's custom shaders + multiple WebGL contexts. The Mac is the only GPU we have automatic access to. The cost: posts only go out after the Mac has been on long enough to drain the queue. The benefit: $0/month, no third-party vendors, no manual triggering.

## Setup (one-time)

1. **Make sure Node.js is installed.** Test: `node --version`. If missing: `brew install node`.

2. **Set `VIDEO_WORKER_TOKEN` on Render.** Pick any long random string (e.g. `openssl rand -hex 32`). Add to your Render web service's Environment as `VIDEO_WORKER_TOKEN=<that string>`. Save → wait for redeploy.

3. **Run the installer from this directory:**

   ```bash
   bash install.sh
   ```

   It will:
   - Install Puppeteer + Chromium into `~/Library/Application Support/earth00-worker/`
   - Prompt you for the Render URL + token (paste the same token from step 2)
   - Generate `~/Library/LaunchAgents/com.earth00.videoworker.plist`
   - Load the agent so it starts at every login + restarts on crash

4. **Prevent Mac sleep when display is off** (so the worker can run while you're not actively at your laptop):
   - System Settings → Battery / Energy Saver
   - Enable "Prevent automatic sleeping when the display is off"

That's it. The worker now runs invisibly. It generates videos for any pending threads the moment your Mac is awake.

## Operating notes

- **Logs:** `tail -f ~/Library/Logs/earth00-worker.log`
- **Status:** `launchctl list | grep earth00`
- **Stop:** `launchctl unload ~/Library/LaunchAgents/com.earth00.videoworker.plist`
- **Re-config** (e.g. new token): delete `~/.earth00-worker.json` and re-run `install.sh`.
- **Update:** pull the latest from git → re-run `install.sh`.

## What happens when you go on vacation

Picker cron on Render keeps picking threads and queueing them in `pending_video` status. Posts don't go out (publisher cron only acts on threads whose videos are ready OR which have been pending > 48h, in which case they go out image-only). When you come back and your Mac wakes up, the worker drains the queue. Publisher cron has a daily cap (default 4 posts/day) so you don't get a backlog flood.
