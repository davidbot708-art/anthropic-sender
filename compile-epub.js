const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ARTICLES_DIR = path.join(__dirname, 'full-articles');
const OUTPUT_DIR = path.join(__dirname, 'articles-output');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'images');

// Ensure directories exist
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Download image and return base64
async function downloadImage(url) {
  return new Promise((resolve) => {
    if (!url || url.startsWith('data:')) {
      resolve(null);
      return;
    }
    
    // Fix relative URLs
    if (url.startsWith('/')) {
      url = 'https://www.anthropic.com' + url;
    }
    
    const protocol = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => resolve(null), 10000);
    
    protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        clearTimeout(timeout);
        downloadImage(res.headers.location).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(timeout);
        resolve(null);
        return;
      }
      
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timeout);
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || 'image/jpeg';
        const base64 = `data:${contentType};base64,${buffer.toString('base64')}`;
        resolve(base64);
      });
      res.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });
    }).on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });
}

// Extract article content with better parsing
function extractArticle(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const filename = path.basename(htmlPath, '.html');
  
  // Extract title
  let title = filename.replace(/-/g, ' ').replace(/^(eng|news|research)\s*/i, '');
  const titleMatch = html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</i) ||
                     html.match(/<title>([^<\\]+)/i);
  if (titleMatch) {
    title = titleMatch[1].trim().replace(/\s*\\\s*Anthropic/g, '').replace(/\s*\|\s*Anthropic/g, '');
  }
  
  // Extract date
  let date = '';
  const dateMatch = html.match(/class="[^"]*agate[^"]*"[^>]*>([A-Z][a-z]+ \d+, \d{4})/i) ||
                    html.match(/>([A-Z][a-z]+ \d+, 20\d{2})</);
  if (dateMatch) {
    date = dateMatch[1];
  }
  
  // Determine category from filename
  let category = 'News';
  if (filename.startsWith('eng-')) category = 'Engineering';
  else if (filename.startsWith('research-')) category = 'Research';
  
  // Extract main content
  let content = '';
  
  // Try to find article body
  const bodyMatch = html.match(/class="Body-module[^"]*"[^>]*data-theme="[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/i);
  if (bodyMatch) {
    content = bodyMatch[1];
  } else {
    // Fallback: extract from <article>
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) {
      content = articleMatch[1];
    }
  }
  
  // Clean content
  content = content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<button[^>]*>[\s\S]*?<\/button>/gi, '')
    .replace(/class="[^"]*"/gi, '')
    .replace(/style="[^"]*"/gi, '')
    .replace(/data-[a-z-]+="[^"]*"/gi, '');
  
  // Extract image URLs
  const images = [];
  const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let match;
  while ((match = imgRegex.exec(content)) !== null) {
    const src = match[1];
    if (src && !src.includes('data:image/svg') && !src.includes('favicon')) {
      images.push(src);
    }
  }
  
  return { title, date, category, content, images, filename };
}

// Process images in content
async function processImages(content, downloadedImages) {
  // Replace image tags with base64 versions
  const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let result = content;
  
  const matches = [...content.matchAll(imgRegex)];
  for (const match of matches) {
    const originalSrc = match[1];
    const base64 = downloadedImages[originalSrc];
    if (base64) {
      result = result.replace(match[0], `<img src="${base64}" style="max-width:100%; height:auto; display:block; margin:15px auto;" alt=""/>`);
    } else {
      // Remove image if we couldn't download it
      result = result.replace(match[0], '');
    }
  }
  
  return result;
}

async function main() {
  console.log('📚 Anthropic Articles EPUB Compiler\n');
  
  // Get all HTML files
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  console.log(`Found ${files.length} articles\n`);
  
  // Extract articles
  const articles = [];
  const seenTitles = new Set();
  
  for (const file of files) {
    try {
      const article = extractArticle(path.join(ARTICLES_DIR, file));
      
      // Deduplicate by title
      const normalizedTitle = article.title.toLowerCase().trim();
      if (seenTitles.has(normalizedTitle)) {
        console.log(`⏭️  Skipping duplicate: ${article.title.substring(0, 50)}`);
        continue;
      }
      seenTitles.add(normalizedTitle);
      
      if (article.content.length > 500) {
        articles.push(article);
        console.log(`✓ [${article.category}] ${article.title.substring(0, 50)}`);
      }
    } catch (e) {
      console.log(`✗ ${file}: ${e.message}`);
    }
  }
  
  console.log(`\n📥 Downloading images...`);
  
  // Collect all unique images
  const allImages = new Set();
  for (const article of articles) {
    for (const img of article.images) {
      allImages.add(img);
    }
  }
  
  // Download images
  const downloadedImages = {};
  let downloaded = 0;
  for (const imgUrl of allImages) {
    const base64 = await downloadImage(imgUrl);
    if (base64) {
      downloadedImages[imgUrl] = base64;
      downloaded++;
    }
    process.stdout.write(`\r  Downloaded ${downloaded}/${allImages.size} images`);
  }
  console.log('\n');
  
  // Sort articles by category then date
  const categoryOrder = { 'Research': 1, 'Engineering': 2, 'News': 3 };
  articles.sort((a, b) => {
    const catDiff = (categoryOrder[a.category] || 4) - (categoryOrder[b.category] || 4);
    if (catDiff !== 0) return catDiff;
    // Sort by date descending (newest first)
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  
  // Build HTML with embedded images
  console.log('📝 Building HTML...');
  
  let currentCategory = '';
  let toc = '<h2>Table of Contents</h2><ul style="list-style:none; padding:0;">';
  let articlesHtml = '';
  
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    
    // Category header
    if (article.category !== currentCategory) {
      currentCategory = article.category;
      articlesHtml += `<h2 style="color:#d4af37; border-bottom:3px solid #d4af37; padding:20px 0 10px; margin-top:40px;">${currentCategory}</h2>`;
      toc += `<li style="margin-top:15px;"><strong>${currentCategory}</strong></li>`;
    }
    
    // Process images in content
    const processedContent = await processImages(article.content, downloadedImages);
    
    // Article
    articlesHtml += `
      <article id="article-${i}" style="margin-bottom:50px; page-break-after:always;">
        <h3 style="color:#1a1a1a; font-size:1.5em; margin-bottom:5px;">${article.title}</h3>
        ${article.date ? `<p style="color:#666; font-size:0.9em; margin-bottom:20px;">${article.date}</p>` : ''}
        <div style="line-height:1.8; font-size:1.05em; text-align:justify;">
          ${processedContent}
        </div>
      </article>
    `;
    
    toc += `<li style="margin:5px 0;"><a href="#article-${i}" style="color:#0066cc; text-decoration:none;">${article.title}</a></li>`;
  }
  
  toc += '</ul>';
  
  const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Anthropic Articles Collection 2026</title>
  <style>
    * { box-sizing: border-box; }
    body { 
      font-family: Georgia, "Times New Roman", serif;
      margin: 0; 
      padding: 20px;
      max-width: 700px;
      margin: 0 auto;
      background: #faf9f5;
      color: #1a1a1a;
    }
    h1 { 
      text-align: center;
      font-size: 2em;
      color: #d4af37;
      border-bottom: 3px solid #d4af37;
      padding-bottom: 15px;
      margin-bottom: 30px;
    }
    img { max-width: 100%; height: auto; display: block; margin: 15px auto; }
    p { line-height: 1.8; margin: 15px 0; }
    a { color: #0066cc; }
    pre, code { 
      background: #f0f0f0; 
      padding: 10px; 
      border-radius: 5px;
      overflow-x: auto;
      font-size: 0.9em;
    }
    blockquote {
      border-left: 4px solid #d4af37;
      margin: 20px 0;
      padding-left: 20px;
      font-style: italic;
      color: #555;
    }
  </style>
</head>
<body>
  <h1>🤖 Anthropic Articles Collection</h1>
  <p style="text-align:center; color:#666;">Compiled February 2026 • ${articles.length} Articles</p>
  
  ${toc}
  
  <hr style="margin:40px 0; border:none; border-top:2px solid #ddd;">
  
  ${articlesHtml}
  
  <footer style="text-align:center; color:#999; padding:30px 0; border-top:2px solid #ddd; margin-top:50px;">
    <p>End of Collection</p>
  </footer>
</body>
</html>`;
  
  const outputPath = path.join(OUTPUT_DIR, 'anthropic-articles-with-images.html');
  fs.writeFileSync(outputPath, fullHtml);
  
  console.log(`\n✅ Done!`);
  console.log(`📄 Output: ${outputPath}`);
  console.log(`📊 Total: ${articles.length} articles`);
  console.log(`🖼️  Images: ${downloaded} embedded`);
  console.log(`📦 Size: ${(fullHtml.length / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(console.error);
