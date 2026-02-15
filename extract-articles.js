const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ARTICLES_DIR = path.join(__dirname, 'full-articles');
const OUTPUT_DIR = path.join(__dirname, 'articles-output');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');

// Ensure directories exist
[OUTPUT_DIR, IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Download image
function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        downloadImage(res.headers.location, filepath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      const file = fs.createWriteStream(filepath);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(filepath); });
    }).on('error', reject);
  });
}

// Extract article content
function extractArticle(htmlPath, articleName) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  
  // Extract title
  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(' \\ Anthropic', '').trim() : articleName;
  
  // Extract main content
  let content = '';
  const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || 
                      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                      html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  
  if (contentMatch) {
    content = contentMatch[1];
  } else {
    // Fallback - get body
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    content = bodyMatch ? bodyMatch[1] : html;
  }
  
  // Extract images
  const imgMatches = content.match(/<img[^>]+src="([^"]+)"/gi) || [];
  const images = [];
  
  for (let i = 0; i < Math.min(imgMatches.length, 10); i++) {
    const srcMatch = imgMatches[i].match(/src="([^"]+)"/);
    if (srcMatch) {
      let src = srcMatch[1];
      if (src.startsWith('//')) src = 'https:' + src;
      else if (src.startsWith('/')) src = 'https://www.anthropic.com' + src;
      
      if (src.startsWith('http') && !src.includes('data:')) {
        images.push({ original: src, index: i });
      }
    }
  }
  
  return { title, content, images };
}

// Process all articles
async function processArticles() {
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  const processed = [];
  
  for (const file of files) {
    const articleName = file.replace('.html', '');
    console.log(`Processing: ${articleName}`);
    
    const article = extractArticle(path.join(ARTICLES_DIR, file), articleName);
    
    // Download images
    const localImages = [];
    for (const img of article.images) {
      const ext = img.original.split('.').pop().split('?')[0] || 'jpg';
      const filename = `${articleName}-${img.index}.${ext}`;
      const filepath = path.join(IMAGES_DIR, filename);
      
      try {
        await downloadImage(img.original, filepath);
        // Update content to use local image
        article.content = article.content.replace(img.original, `images/${filename}`);
        localImages.push(filename);
        console.log(`  Downloaded: ${filename}`);
      } catch (e) {
        console.log(`  Failed: ${img.original}`);
      }
    }
    
    processed.push({ ...article, filename: articleName });
  }
  
  // Build HTML
  let fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Anthropic Articles 2026</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; padding: 20px; max-width: 800px; }
    h1 { text-align: center; color: #1a1a1a; border-bottom: 2px solid #d4af37; padding-bottom: 10px; }
    h2 { color: #333; margin-top: 40px; border-bottom: 1px solid #ccc; padding-bottom: 10px; }
    img { max-width: 100%; height: auto; margin: 15px 0; }
    p { line-height: 1.8; text-align: justify; margin: 15px 0; font-size: 1.1em; }
    .article { margin-bottom: 60px; }
    a { color: #0066cc; }
  </style>
</head>
<body>
  <h1>🤖 Anthropic Articles 2026</h1>
`;

  for (const article of processed) {
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

  fs.writeFileSync(path.join(OUTPUT_DIR, 'anthropic-articles.html'), fullHtml);
  console.log(`\n✅ Saved: ${path.join(OUTPUT_DIR, 'anthropic-articles.html')}`);
  console.log(`Images: ${fs.readdirSync(IMAGES_DIR).length} files`);
}

processArticles().catch(console.error);
