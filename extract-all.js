const fs = require('fs');
const path = require('path');

const ARTICLES_DIR = path.join(__dirname, 'full-articles');
const OUTPUT_FILE = path.join(__dirname, 'articles-output', 'anthropic-all-articles.html');

// Ensure output dir
const OUTPUT_DIR = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Extract article content
function extractArticle(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const filename = path.basename(htmlPath, '.html');
  
  // Extract title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  let title = titleMatch ? titleMatch[1].trim() : filename;
  title = title.replace(/ \\ Anthropic/g, '').replace(/-/g, ' ');
  
  // Extract main content - try multiple patterns
  let content = '';
  const patterns = [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class="[^"]*prose[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class="[^"]*article[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  ];
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1].length > 1000) {
      content = match[1];
      break;
    }
  }
  
  // If no pattern matched, get body
  if (!content) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    content = bodyMatch ? bodyMatch[1] : html;
  }
  
  // Clean up content
  content = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<img[^>]*>/gi, '[图片]')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
  
  return { title, content, filename };
}

// Process all articles
const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
const articles = [];

console.log(`Found ${files.length} articles`);

for (const file of files) {
  try {
    const article = extractArticle(path.join(ARTICLES_DIR, file));
    if (article.content.length > 500) {
      articles.push(article);
      console.log(`✓ ${article.title.substring(0, 50)}`);
    }
  } catch (e) {
    console.log(`✗ ${file}: ${e.message}`);
  }
}

// Build HTML
let fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Anthropic Articles 2026 - All</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 20px; max-width: 800px; margin: 0 auto; background: #f5f5f5; }
    h1 { text-align: center; color: #d4af37; background: #1a1a1a; padding: 20px; margin: 0; }
    h2 { color: #1a1a1a; margin-top: 30px; border-bottom: 2px solid #d4af37; padding-bottom: 10px; }
    img { max-width: 100%; height: auto; display: block; margin: 15px auto; }
    p { line-height: 1.8; text-align: justify; margin: 15px 0; font-size: 1.05em; color: #333; }
    .article { background: white; padding: 25px; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    a { color: #0066cc; }
    .meta { color: #666; font-size: 0.9em; margin-bottom: 15px; }
  </style>
</head>
<body>
  <h1>🤖 Anthropic Articles 2026 (${articles.length}篇)</h1>
`;

for (const article of articles) {
  fullHtml += `
  <div class="article">
    <h2>${article.title}</h2>
    ${article.content}
  </div>
`;
}

fullHtml += `
</body>
</html>`;

fs.writeFileSync(OUTPUT_FILE, fullHtml);
console.log(`\n✅ Saved: ${OUTPUT_FILE}`);
console.log(`Total size: ${(fullHtml.length / 1024).toFixed(1)} KB`);
