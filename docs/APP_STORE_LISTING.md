# App Store listing — Newone Chat

Status: draft for the 1.0 submission (owner review pending). Bundle `com.totallynotwoojin.newone`, ASC app id 6808028951, name "Newone Chat".

## Name / subtitle
- **Name:** Newone Chat
- **Subtitle (30 chars):** Chat in your language

## Promotional text (170 chars)
Message anyone — in English, Spanish, or Korean. Newone translates as you chat, so every conversation stays in your language and the original is always one tap away.

## Description
Newone Chat is a private messenger built for people who don't share a language.

Pick English, Spanish, or Korean when you sign up. When friends write in a different language, Newone translates their messages automatically — and keeps the original right there, so nothing is ever lost in translation.

**Find people, your way**
Search by username to find friends. Anyone can send you a message request; you decide who gets through. Block and report tools are always one tap away.

**Everything a modern messenger should have**
- Private one-to-one chats and group chats
- Photos, videos, documents, and voice notes
- Replies, reactions, editing, forwarding, and pinned messages
- Read receipts and typing indicators
- Message search across all your conversations
- Push notifications when the app is closed

**Built with respect**
- No ads. Your data is never sold.
- Translation runs under a zero-data-retention policy — your messages are never used to train anything.
- Delete your account any time from Settings.

Newone Chat works on iPhone and Android, so everyone you know can join.

## Keywords (100 chars)
messenger,chat,translate,translation,korean,spanish,english,friends,group chat,voice notes,private

## What's new (1.0)
First release: private chats and groups with automatic English/Spanish/Korean translation, photos, videos, voice notes, reactions, replies, and message requests.

## URLs
- Privacy policy: https://totallynotwoojin.github.io/newone-legal/privacy.html
- Terms: https://totallynotwoojin.github.io/newone-legal/terms.html
- Support: mailto:totallynotwoojin@gmail.com (a support page on newonechat.com can replace this)

## App Review information
- Sign-in required: yes. Demo account: `review@newonechat.com` with the password in the owner's secrets store (`~/.config/newone/review-account-password.txt`, entered in the App Store Connect demo-account field). Since v3.2 the app signs in with email then password only ("Sign in" chip → email → Continue → password); "Forgot password?" emails a code. The fixed one-time code for the review account stays configured server-side for the web/admin route but is no longer offered in the app.
- Notes for reviewer: Messaging between users requires two accounts; the reviewer may create a second account with any email address to exercise message requests and translation. Translation of a message into the reader's language happens automatically within seconds.
- Contact: Woojin Lee, +1 770 686 8414, totallynotwoojin@gmail.com

## App Privacy (data types to declare)
- Contact info: email address (account) — linked to user, used for app functionality.
- User content: messages, photos/videos/audio, other user content — linked to user, app functionality.
- Identifiers: user ID, device ID (push registration) — linked to user, app functionality.
- Usage data / diagnostics: crash and performance diagnostics — not linked (if a crash reporter is added); currently none collected.
- No data used for tracking; no advertising.

## Age rating
4+ (user-generated content with moderation tools: block, report, delete).

## Category
Social Networking (secondary: Productivity).

## Screenshots (to generate from the simulator, 6.7" and 6.1")
1. Sign-up with the language picker
2. Chats list with a translated conversation
3. A conversation showing original + translation
4. People: username search and friends
5. Group chat in three languages
6. Settings (language, notifications, privacy)
