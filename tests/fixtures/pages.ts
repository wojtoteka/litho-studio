/**
 * Realistic "dirty" pages used across the engine tests.
 *
 * Each fixture is a page Litho must open and edit correctly *without* the user
 * reorganising anything first. They differ deliberately in how CSS and JS are
 * placed, in indentation, and in how tidy the markup is — because the product
 * requirement is that none of that matters.
 */

export interface Fixture {
  name: string;
  /** Files as they exist on disk, keyed by project-relative path. */
  files: Record<string, string>;
  entry: string;
}

/**
 * Everything in one file, no external assets at all, two-space indentation
 * abandoned halfway through. This is what a single-file AI answer looks like.
 */
export const inlineEverything: Fixture = {
  name: 'inline-everything',
  entry: 'index.html',
  files: {
    'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Portfolio</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box }
body { font-family: Arial, sans-serif; background:#111; color:#eee }
.hero { padding: 80px 20px; text-align:center }
.hero h1 { font-size: 3rem; margin-bottom: 1rem }
@media (max-width: 640px) { .hero h1 { font-size: 2rem } }
</style>
</head>
<body>
<!-- Hero section -->
<div class="hero">
<h1>Jan Kowalski</h1>
<p class="subtitle">Frontend developer</p>
<a href="#kontakt" class="btn">Napisz do mnie</a>
</div>
<footer class="site-footer">
<p>&copy; wojtoteka.ovh 2024–2026</p>
</footer>
<script>
document.querySelectorAll('a[href^="#"]').forEach(function (link) {
  link.addEventListener('click', function (event) {
    event.preventDefault();
  });
});
</script>
</body>
</html>
`,
  },
};

/**
 * Three stylesheets — a CDN reset, a local base, a local theme — plus a
 * separate script file. The generator must write into `theme.css` (last
 * writable) and must never touch the CDN link.
 */
export const multipleStylesheets: Fixture = {
  name: 'multiple-stylesheets',
  entry: 'index.html',
  files: {
    'index.html': `<!doctype html>
<html lang="pl">
	<head>
		<meta charset="utf-8" />
		<link rel="stylesheet" href="https://cdn.example.com/reset.css" />
		<link rel="stylesheet" href="css/base.css" />
		<link rel="stylesheet" href="css/theme.css" media="screen" />
		<title>Sklep</title>
	</head>
	<body>
		<header id="top">
			<nav class="nav">
				<a class="nav-link" href="/">Start</a>
				<a class="nav-link" href="/sklep">Sklep</a>
			</nav>
		</header>
		<main>
			<section class="products">
				<article class="card">
					<h2>Produkt</h2>
					<p>Opis produktu.</p>
				</article>
			</section>
		</main>
		<script src="js/app.js"></script>
	</body>
</html>
`,
    'css/base.css': `body {\n\tmargin: 0;\n\tfont-family: system-ui;\n}\n`,
    'css/theme.css': `.card {\n\tborder: 1px solid #ddd;\n\tpadding: 16px;\n}\n\n@media (max-width: 640px) {\n\t.card {\n\t\tpadding: 8px;\n\t}\n}\n`,
    'js/app.js': `console.info("sklep gotowy");\n`,
  },
};

/**
 * A bare fragment: no doctype, no `<html>`, no `<head>`, no `<body>`, with an
 * unclosed paragraph and a stray inline style. The HTML5 parsing algorithm
 * normalises all of it; the editor must end up with an editable tree.
 */
export const fragmentPage: Fixture = {
  name: 'fragment',
  entry: 'index.html',
  files: {
    'index.html': `<div class=wrapper>
<p>Pierwszy akapit
<p>Drugi akapit</p>
<img src="assets/logo.png" alt="Logo">
<span style="color:red">Uwaga</span>
</div>
`,
  },
};

/**
 * Messy but valid: comments everywhere, unused classes, mixed quote styles,
 * an inline `<style>` *after* an external sheet, and a module script. Modelled
 * on the output of a code assistant that was asked to "make it responsive".
 */
export const messyGenerated: Fixture = {
  name: 'messy-generated',
  entry: 'index.html',
  files: {
    'index.html': `<!doctype html>
<html lang='pl'>
<head>
    <meta charset='utf-8'>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <!-- Główne style -->
    <link rel=stylesheet href='styles/main.css'>
    <title>Landing</title>
    <!-- poprawki responsywne dopisane później -->
    <style>
      @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
      .unused-legacy-class { display: none }
    </style>
</head>
<body class="theme-dark">
  <section class="grid" id="features">
        <div class="feature"><h3>Szybko</h3><p>Bardzo szybko.</p></div>
    <div class="feature"><h3>Prosto</h3><p>Bardzo prosto.</p></div>
  </section>
  <footer><small>Copyright 2024-aktualna data, wszystkie prawa zastrzeżone.</small></footer>
  <script type="module">
    export const version = "1.0";
  </script>
  <script src="scripts/analytics.js"></script>
</body>
</html>
`,
    'styles/main.css': `.grid {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 24px;\n}\n`,
    'scripts/analytics.js': `// placeholder\n`,
  },
};

export const allFixtures: Fixture[] = [inlineEverything, multipleStylesheets, fragmentPage, messyGenerated];
