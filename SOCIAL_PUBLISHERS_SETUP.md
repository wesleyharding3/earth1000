# Social Publishers — Env Var Setup

Each platform is independently enabled/disabled by whether its required
env vars are set. Missing vars = the platform stays dark in the editor's
publisher-status strip (red ✗ instead of green ✓). No failures, no errors
— it just doesn't try.

Set these in your Render dashboard → Environment, then redeploy.

Difficulty ladder, easiest to hardest. **Start with BlueSky.** It's a
5-minute setup and proves the whole pipeline end-to-end before you
fight with the harder ones.

---

## 1. BlueSky  (≈ 5 min)

No developer app needed. Just an app password from your account.

1. Go to https://bsky.app/settings/app-passwords
2. Click **Add App Password**, name it "Earth00 Publisher", save the
   generated password (you only see it once)
3. Set env vars:

```
BLUESKY_HANDLE=earth00.bsky.social     # whatever your @handle is
BLUESKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

That's it. Test from the editor's Publish button — your post will appear
on your BlueSky feed in ~2 seconds.

---

## 2. X (Twitter)  (≈ 30 min)

Requires a Developer account. Free tier allows **1,500 posts/month** —
plenty for 2-3/day.

1. Apply at https://developer.x.com (sign in with your X account, fill
   out "use case" form — usually instant approval for personal projects)
2. Create a Project + App in the dashboard
3. **App settings → User authentication settings**:
   - Type of App: **Web App, Automated App or Bot**
   - Permissions: **Read and write**
   - Callback URL: `https://earth00.com/auth/x/callback` (placeholder
     — required field but unused for our flow)
4. **Keys and tokens** tab → generate:
   - **Consumer Keys** → API Key + API Key Secret
   - **Authentication Tokens** → Access Token + Access Token Secret
   - ⚠ Generate Access Tokens **AFTER** enabling read-and-write
     permission. If you skip this, you'll get HTTP 403 on every post.
5. Set env vars:

```
X_API_KEY=
X_API_SECRET=
X_ACCESS_TOKEN=
X_ACCESS_TOKEN_SECRET=
X_SCREEN_NAME=earth00app           # optional — used to build permalinks
```

---

## 3. Reddit  (≈ 15 min)

Requires a Script-type app and a real Reddit account.

1. Go to https://www.reddit.com/prefs/apps → **create another app**
2. Choose **script** (NOT web app or installed app)
3. Fill in:
   - Name: `Earth00 Publisher`
   - Redirect URI: `http://localhost:8080` (placeholder, unused)
4. After creating, copy:
   - **client_id**: the 14-character string under "personal use script"
   - **client_secret**: the longer string next to "secret"
5. Set env vars (use the Reddit account that will post):

```
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USERNAME=your_reddit_handle
REDDIT_PASSWORD=your_reddit_password   # if 2FA: append your TOTP digits
REDDIT_USER_AGENT=earth00:v1.0 (by /u/your_reddit_handle)
REDDIT_DEFAULT_SUBREDDIT=test          # change per environment
```

**Important:** Reddit's spam filter is aggressive against new accounts.
The first few posts in any subreddit may be held for mod review (the
API call succeeds but the post isn't visible publicly until approved).
This is normal — sub mods unblock you after they see legit activity.

The composer's draft.subreddit can override REDDIT_DEFAULT_SUBREDDIT per
post. We currently default everything to `REDDIT_DEFAULT_SUBREDDIT` —
edit the draft in the Social Queue editor to pick a different sub per
thread.

---

## 4. LinkedIn  (≈ 1 hr)

Requires a developer app. Personal-profile posting is straightforward;
company-page posting needs admin scopes (not covered here).

1. Create app at https://developer.linkedin.com/
2. Add the **Share on LinkedIn** product (instant approval for personal)
3. Use the **OAuth 2.0 token generator** in the developer portal:
   - Sign in with the LinkedIn account you want to post AS
   - Select scopes: `w_member_social`, `openid`, `profile`
   - Generate access token (valid 60 days)
4. To find your author URN:
   ```bash
   curl -H "Authorization: Bearer <YOUR_TOKEN>" https://api.linkedin.com/v2/userinfo
   ```
   The `sub` field is your person ID. URN = `urn:li:person:<sub>`.
5. Set env vars:

```
LINKEDIN_ACCESS_TOKEN=<your 60-day token>
LINKEDIN_AUTHOR_URN=urn:li:person:XXXXXXXXXX
```

⚠ The token expires every 60 days. Set a calendar reminder to regenerate
before expiry, or implement the refresh-token flow (not yet built).

---

## 5. Instagram  (≈ 2 hrs, most painful)

The hardest. Requires Meta Developer setup + Business IG + linked
Facebook Page. Skip until everything else is humming.

1. Convert your IG account to **Business** or **Creator** (Settings →
   Account type and tools)
2. Link the IG account to a Facebook Page (any Page you admin)
3. Create app at https://developers.facebook.com/apps:
   - Type: **Business**
   - Add product: **Instagram Graph API** (or Instagram Platform)
4. Through Graph API Explorer, generate a User Access Token with
   scopes: `instagram_basic`, `instagram_content_publish`,
   `pages_show_list`, `pages_read_engagement`
5. Exchange short-lived (1-hour) token → long-lived (60-day):
   ```bash
   curl -G "https://graph.facebook.com/v22.0/oauth/access_token" \
     -d grant_type=fb_exchange_token \
     -d client_id=<your-app-id> \
     -d client_secret=<your-app-secret> \
     -d fb_exchange_token=<short-lived-token>
   ```
6. Find your IG User ID:
   ```bash
   # First get your Pages:
   curl "https://graph.facebook.com/v22.0/me/accounts?access_token=<TOKEN>"
   # Then for the right page id:
   curl "https://graph.facebook.com/v22.0/<PAGE-ID>?fields=instagram_business_account&access_token=<TOKEN>"
   # Returns: { "instagram_business_account": { "id": "1784..." } } — that's IG_USER_ID
   ```
7. Set env vars:

```
IG_ACCESS_TOKEN=<your 60-day token>
IG_USER_ID=<the Instagram Business User ID from step 6>
IG_GRAPH_VERSION=v22.0     # optional
```

⚠ Token expires every 60 days. Same calendar-reminder rule as LinkedIn.

---

## Verifying

After setting env vars, push to Render. Then in earth-editor → Social
Queue tab, look at the publisher-status strip at the top:

```
✓ x    ✓ reddit    ✗ linkedin    ✓ bluesky    ✗ instagram
```

Green ✓ = configured and ready. Red ✗ = missing env vars. Only ✓
platforms will actually attempt to post.

You can also hit `/api/admin/social-queue/configured` directly to see
the same status as JSON.

---

## Cron schedule

Add as Render Cron Jobs:

| Job | Schedule (UTC) | Command |
|---|---|---|
| Picker (morning) | `30 6 * * *` | `node socialQueuePickerCron.js` |
| Picker (afternoon) | `30 16 * * *` | `node socialQueuePickerCron.js` |

Don't auto-publish — admin approval via the Social Queue tab stays in
the loop. The picker fills the queue at 06:30 / 16:30 UTC; you approve
through the day; you click Publish manually.

If you ever want a fully-automated publisher cron, that's a separate
script — only worth adding after 30 days of manually approving and you
trust the picker + your edits.
