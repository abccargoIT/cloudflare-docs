# Testing ABC Cargo Engage on your own computer

This guide lets you run the platform on your own machine and watch it handle
customer messages, before anything is connected to a live system.

**Nothing in this guide can touch a live system.** It does not connect to
Freshworks, it does not connect to Meta, and it cannot send a message to a real
customer. The messages you will see are pretend ones created on your own
computer. The database is a file inside this project folder; deleting the
folder deletes it completely.

---

## Start here: open `demo/app.html`

**Double-click `demo/app.html`.** It opens in your browser. Nothing to
install, nothing to start, no internet connection needed.

That one file is the whole working demonstration: the agent inbox for all
three numbers, leads, quotations, bookings, tickets, calls and one customer
timeline. You can type a message as a customer and watch the platform decide
what to do with it, and a panel under the thread explains, in words, why it
did what it did.

It is not a drawing of the product. The intent recognition, the service-target
clocks, the reference formats and the lead and shipment transitions are the
platform's own code, compiled into the page by `npm run build:app`. Change a
rule in `src/`, rebuild, and the page changes with it. Only the storage is
different: the records live in your browser instead of the database, and
nothing leaves the machine.

## The other files, and what each is for

| File                            | What it is                                                           |
| ------------------------------- | -------------------------------------------------------------------- |
| `demo/app.html`                 | **The working demonstration.** Start here.                           |
| `demo/message-tester.html`      | One screen: type a message, see how it is classified and what is due |
| `demo/management-briefing.html` | The slides for the session with Management                           |
| `demo/engage.html`              | The earlier screen mock-up, kept for reference                       |
| `demo/platform.html`            | The earlier architecture walkthrough, kept for reference             |

Running the real Worker, with the database and the queue, is a separate
exercise. The steps are below, and it proves the same decisions against real
storage.

---

## Before you start

You need **Node.js version 22 or newer** on the machine.

Check whether you already have it. Open PowerShell and type:

```powershell
node --version
```

- If it prints something like `v22.11.0` or higher, you are ready.
- If it says the command is not recognised, or prints a lower number, install
  the **LTS** version from <https://nodejs.org>, then close and reopen
  PowerShell.

Nothing else is required.

---

## Step 1 — Set it up (once)

Open PowerShell, go to the project folder, and run the setup script:

```powershell
Set-Location "<path to>\abc-cargo\whatsapp-platform"
.\tools\setup-local.ps1
```

If PowerShell refuses to run the script, allow it for that window only:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
```

The script does six things and tells you what it is doing at each step:

1. Checks your Node.js version.
2. Downloads the project's dependencies.
3. Creates a local settings file with **test-only** credentials.
4. Creates a small database file on your computer.
5. Loads sample customers and shipments so the screens are not empty.
6. Runs the automated tests (70 of them).

The first run takes a few minutes, mostly downloading. After that it is quick.

---

## Step 2 — Start the platform

In the same window:

```powershell
npm run dev
```

You will see it start and print a local address, normally
`http://127.0.0.1:8787`. **Leave this window open.** This is the platform
running. Closing the window stops it.

---

## Step 3 — Send it pretend customer messages

Open a **second** PowerShell window, go to the same folder, and run:

```powershell
npm run simulate
```

This sends four pretend WhatsApp messages and shows you what the platform did
with each one.

### What you should see

**Scenario 1 — a rate enquiry from someone who has never written before**

> "Hello, how much to send 40 kg from Sharjah to Chennai?"

The platform creates a **sales lead**. Nobody had to be at a desk. This is the
enquiry that today would sit unread in a queue until morning.

**Scenario 2 — a damage claim**

> "One carton of ABC-KSA-030488 arrived open and two shirts are missing"

The platform opens a **claim ticket**, links it to that shipment, and starts a
response clock. Note that the message also contains a shipment reference — a
simpler system would have treated this as a tracking question and sent an
automated status update to a customer who is complaining.

**Scenario 3 — a tracking question**

> "Where is my shipment ABC-UAE-088210?"

The platform creates **no ticket and no lead**. It recognises the reference and
records the message against the existing shipment. Not creating work is as
important as creating it.

**Scenario 4 — Arabic**

> "السلام عليكم، أحتاج سعر شحن إلى مانيلا"

Recognised as a rate enquiry and turned into a lead, the same as the English one.

### Try your own wording

```powershell
node tools\simulate-inbound.mjs --text "my parcel is broken"
node tools\simulate-inbound.mjs --text "please send me the invoice copy"
node tools\simulate-inbound.mjs --text "hi"
```

This is the honest test. Type things your customers actually write and see
whether the platform reaches the right conclusion. **When it gets something
wrong, tell me the exact wording** — that is how the rules get corrected, and
it is far more useful than a general impression.

---

## Step 4 — Look at the data directly (optional)

In the second window you can ask the platform questions. The key below is the
local test key from `.dev.vars`.

See everything known about one customer, on one page:

```powershell
curl.exe -H "Authorization: Bearer local-test-api-key" http://127.0.0.1:8787/api/customers/cus_971506621184
```

See all open tickets:

```powershell
curl.exe -H "Authorization: Bearer local-test-api-key" "http://127.0.0.1:8787/api/tickets?open=true"
```

See all sales leads:

```powershell
curl.exe -H "Authorization: Bearer local-test-api-key" http://127.0.0.1:8787/api/leads
```

---

## Starting again from scratch

To wipe everything and start clean:

```powershell
Remove-Item -Recurse -Force .wrangler
.\tools\setup-local.ps1
```

Only files inside this project folder are removed.

---

## If something does not work

| What you see                                    | What it means                                   | What to do                                                   |
| ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `node` is not recognised                        | Node.js is not installed                        | Install the LTS from <https://nodejs.org>, reopen PowerShell |
| Script cannot be loaded                         | PowerShell is blocking scripts                  | Run the `Set-ExecutionPolicy` line in Step 1                 |
| `Nothing is answering at http://127.0.0.1:8787` | The platform is not running                     | Run `npm run dev` in the other window first                  |
| `npm install` fails                             | Usually a corporate proxy or firewall           | Send me the exact message                                    |
| A customer record does not appear               | The background queue may not be running locally | Send me the output; there is a fallback path                 |

Send me the exact text of any error. Do not send screenshots of credentials —
the test key above is a fake one and safe to share, but no other key is.

---

## What this does and does not prove

**It proves:**

- The platform accepts a genuine WhatsApp webhook and verifies its signature.
  The simulator signs its message the same way Meta does; if that check were
  broken, the message would be rejected.
- Messages are correctly understood in English and Arabic.
- The right record is created — or correctly not created.
- Response clocks are set against each region's own working hours.
- Everything about a customer lands on one timeline.

**It does not prove:**

- That real Meta delivery works. That needs a real number connected, which
  needs your approval and a cutover window.
- That the bot conversations match ABC Cargo's current ones. I have not seen
  those flows yet.
- That the service targets are correct. The ones in the code are placeholders
  until the real SLA policy is exported from Freshworks.

---

## A reminder on safety

The credentials in `.dev.vars` are deliberately invalid. If any part of the
code tried to reach Meta, it would fail rather than send something real. The
file is excluded from version control and must never hold a real key.

No live ABC Cargo system will be touched at any point without the exact
approval phrase, agreed in advance, for that specific change.
