<template>
  <main class="deprecated-page">
    <section class="deprecated-card" aria-labelledby="deprecated-title">
      <div class="deprecated-mark" aria-hidden="true">!</div>
      <p class="deprecated-kicker">DIGITAL TWIN DASHBOARD</p>
      <h1 id="deprecated-title">旧版网页大屏已弃用</h1>
      <p class="deprecated-message">
        当前系统已迁移至 Unity 三维大屏，原 Three.js 网页大屏不再提供访问。
      </p>
      <p class="deprecated-hint">请从软件桌面入口启动新版大屏。</p>
    </section>
  </main>
</template>

<style scoped>
.deprecated-page {
  box-sizing: border-box;
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  color: #eef4f2;
  background:
    radial-gradient(circle at 50% 42%, rgba(36, 71, 84, .42), transparent 42%),
    #0b141c;
  font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
}

.deprecated-card {
  width: min(560px, 100%);
  padding: 48px 44px;
  text-align: center;
  border: 1px solid rgba(242, 184, 91, .34);
  border-radius: 18px;
  background: linear-gradient(145deg, rgba(24, 40, 48, .96), rgba(13, 24, 32, .98));
  box-shadow: 0 24px 70px rgba(0, 0, 0, .38), inset 0 1px rgba(255, 255, 255, .05);
}

.deprecated-mark {
  width: 54px;
  height: 54px;
  display: grid;
  place-items: center;
  margin: 0 auto 22px;
  border: 1px solid rgba(242, 184, 91, .6);
  border-radius: 50%;
  color: #f2b85b;
  font-size: 30px;
  font-weight: 700;
}

.deprecated-kicker {
  margin: 0 0 12px;
  color: #f2b85b;
  font-size: 11px;
  letter-spacing: .2em;
}

h1 {
  margin: 0;
  font-size: clamp(26px, 5vw, 38px);
  letter-spacing: .04em;
}

.deprecated-message {
  margin: 22px 0 0;
  color: #d2dcda;
  font-size: 16px;
  line-height: 1.8;
}

.deprecated-hint {
  margin: 18px 0 0;
  color: #95aaa8;
  font-size: 13px;
}

@media (max-width: 520px) {
  .deprecated-page { padding: 20px; }
  .deprecated-card { padding: 38px 24px; }
}
</style>
