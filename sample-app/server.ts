// A small fictional web app ("Fieldnote") for testing the runner end to end
// without touching any real site: login, a dashboard, a slow report, an
// iframe, a new tab, a select, checkboxes, a dialog, and a page that tries to
// leave its allowed hosts. All data is made up.
//
//   npm run sample-app            (port 4400)
import express from "express";
import type { Server } from "node:http";

const USER = { email: "grower@fieldnote.test", password: "correct-horse-battery" };

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px system-ui;margin:2rem;max-width:760px}label{display:block;margin:.6rem 0}input,select,textarea{font:inherit;padding:.4rem}
button{font:inherit;padding:.5rem 1rem}.card{border:1px solid #ccc;border-radius:8px;padding:1rem;margin:1rem 0}[hidden]{display:none!important}</style>
</head><body>${body}</body></html>`;

export function createSampleApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (_req, res) => res.redirect("/login"));

  app.get("/login", (req, res) =>
    res.send(
      page(
        "Sign in · Fieldnote",
        `<h1>Fieldnote</h1>
        ${req.query.error ? '<p role="alert">That email and password don\'t match.</p>' : ""}
        <form method="post" action="/login">
          <label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
          <label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label>
          <button type="submit">Sign in</button>
        </form>`,
      ),
    ),
  );

  app.post("/login", (req, res) => {
    if (req.body.email === USER.email && req.body.password === USER.password) {
      res.setHeader("Set-Cookie", "fn_session=ok; Path=/; HttpOnly; SameSite=Lax");
      return res.redirect("/dashboard");
    }
    res.redirect("/login?error=1");
  });

  app.use((req, res, next) => {
    if (["/login", "/frame", "/elsewhere"].includes(req.path) || req.headers.cookie?.includes("fn_session=ok")) return next();
    res.redirect("/login");
  });

  app.get("/dashboard", (_req, res) =>
    res.send(
      page(
        "Dashboard · Fieldnote",
        `<h1>Welcome back, Demo Grower</h1>
        <nav><a href="/report/123" target="_blank" data-testid="open-report">Open soil report</a> · <a href="/elsewhere-redirect">Partner portal</a></nav>
        <div class="card">
          <h2>New field</h2>
          <label>Field name <input placeholder="e.g. North 40" id="field-name"></label>
          <label>Crop <select id="crop"><option value="">Choose…</option><option value="corn">Corn</option><option value="alfalfa">Alfalfa</option><option value="pecan">Pecans</option></select></label>
          <label><input type="checkbox" id="irrigated"> Irrigated</label>
          <button id="save-field" type="button">Save field</button>
          <p id="saved" role="status" hidden></p>
        </div>
        <div class="card">
          <h2>Reports</h2>
          <button type="button" id="generate">Generate report</button>
          <p id="loading" hidden>Generating…</p>
          <p id="ready" hidden>Report ready</p>
        </div>
        <div class="card">
          <h2>Ask the agronomist</h2>
          <iframe src="/frame" title="Chat" width="100%" height="160"></iframe>
        </div>
        <button type="button" id="open-dialog">Delete sample data</button>
        <div role="dialog" aria-label="Confirm" id="dialog" hidden><p>Delete all sample data?</p><button type="button" id="confirm">Yes, delete</button></div>
        <p id="deleted" hidden>Sample data deleted</p>
        <script>
          const $ = (id) => document.getElementById(id);
          $("save-field").onclick = () => {
            const name = $("field-name").value, crop = $("crop").value;
            $("saved").hidden = false;
            $("saved").textContent = name && crop ? "Saved " + name + " (" + crop + (${'$'}("irrigated").checked ? ", irrigated" : "") + ")" : "Name and crop are required";
          };
          $("generate").onclick = () => { $("loading").hidden = false; setTimeout(() => { $("loading").hidden = true; $("ready").hidden = false; }, 1500); };
          $("open-dialog").onclick = () => setTimeout(() => { $("dialog").hidden = false; }, 600);
          $("confirm").onclick = () => { $("dialog").hidden = true; $("deleted").hidden = false; };
          console.error("fieldnote: demo console error for evidence capture");
        </script>`,
      ),
    ),
  );

  app.get("/frame", (_req, res) =>
    res.send(
      page(
        "Chat",
        `<textarea placeholder="Type a message" id="msg"></textarea> <button type="button" id="send">Send</button><p id="sent"></p>
        <script>document.getElementById("send").onclick = () => { document.getElementById("sent").textContent = "Sent: " + document.getElementById("msg").value; };</script>`,
      ),
    ),
  );

  app.get("/report/:id", (req, res) =>
    res.send(page(`Soil report ${req.params.id}`, `<h1>Soil report #${req.params.id}</h1><table><tr><th>Nutrient</th><th>ppm</th></tr><tr><td>Nitrate-N</td><td>14</td></tr><tr><td>Phosphorus</td><td>22</td></tr></table>`)),
  );

  // Sends the browser to another host name (localhost instead of 127.0.0.1), which tests keep off the allow-list.
  app.get("/elsewhere-redirect", (req, res) => res.redirect(`http://localhost:${req.socket.localPort}/elsewhere`));
  app.get("/elsewhere", (_req, res) => res.send(page("Elsewhere", "<h1>Another site</h1>")));

  return app;
}

export function startSampleApp(port = 0): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createSampleApp().listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, url: `http://127.0.0.1:${p}` });
    });
  });
}

export const SAMPLE_USER = USER;

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await startSampleApp(Number(process.env.PORT ?? 4400));
  console.log(`Fieldnote sample app on ${url} (sign in as ${USER.email})`);
}
