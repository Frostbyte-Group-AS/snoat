export function renderErrorPage(): string {
  return `<!doctype html>
<html lang="no">
  <head>
    <meta charset="utf-8" />
    <title>Denne siden lastet ikke</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      /* Speiler designsystemet «Ink & Sun»: svart strek, ingen skygge,
         firkantede knapper, gul håndstrek. Sida rendres uten CSS-bundelen,
         så verdiene står inline. */
      body { font: 300 17px/1.55 "Helvetica Neue", Helvetica, Arial, sans-serif; background: #fff; color: #000; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 20px; }
      .card { max-width: 520px; width: 100%; text-align: center; padding: 32px 30px; border: 2.6px solid #000; border-radius: 16px; }
      h1 { font-size: 28px; font-weight: 700; margin: 0; letter-spacing: -0.005em; }
      .swoosh { display: block; width: 74px; height: 10px; margin: 8px auto 0; background: #ffed88; border-radius: 6px 6px 6px 6px / 10px 10px 10px 10px; }
      p { margin: 16px 0 0; }
      .actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 24px; }
      a, button { padding: 14px 26px; border-radius: 0; font: 700 16px "Helvetica Neue", Helvetica, Arial, sans-serif; cursor: pointer; text-decoration: none; border: 2px solid #000; }
      .primary { background: #000; color: #fff; }
      .secondary { background: #fff; color: #000; }
      a:hover, button:hover { background: #ffed88; color: #000; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Denne siden lastet ikke</h1>
      <span class="swoosh"></span>
      <p>Noe gikk galt hos oss. Prøv å laste inn på nytt, eller gå tilbake til forsiden.</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">Prøv igjen</button>
        <a class="secondary" href="/">Til forsiden</a>
      </div>
    </div>
  </body>
</html>`;
}
