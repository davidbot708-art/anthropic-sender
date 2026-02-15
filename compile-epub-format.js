const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const epub = require('epub-gen-memory').default;

const ARTICLES_DIR = path.join(__dirname, 'full-articles');
const OUTPUT_DIR = path.join(__dirname, 'articles-output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Download image and return base64
async function downloadImage(url) {
  return new Promise((resolve) => {
    if (!url || url.startsWith('data:')) {
      resolve(null);
      return;
    }
    
    if (url.startsWith('/')) {
      url = 'https://www.anthropic.com' + url;
    }
    
    const protocol = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => resolve(null), 8000);
    
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
      res.on('error', () => { clearTimeout(timeout); resolve(null); });
    }).on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

// Extract article content
function extractArticle(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const filename = path.basename(htmlPath, '.html');
  
  // Title
  let title = filename.replace(/-/g, ' ').replace(/^(eng|news|research)\s*/i, '');
  const titleMatch = html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</i) ||
                     html.match(/<title>([^<\\]+)/i);
  if (titleMatch) {
    title = titleMatch[1].trim().replace(/\s*\\\s*Anthropic/g, '').replace(/\s*\|\s*Anthropic/g, '');
  }
  
  // Date
  let date = '';
  const dateMatch = html.match(/class="[^"]*agate[^"]*"[^>]*>([A-Z][a-z]+ \d+, \d{4})/i) ||
                    html.match(/>([A-Z][a-z]+ \d+, 20\d{2})</);
  if (dateMatch) date = dateMatch[1];
  
  // Category
  let category = 'News';
  if (filename.startsWith('eng-')) category = 'Engineering';
  else if (filename.startsWith('research-')) category = 'Research';
  
  // Content
  let content = '';
  const bodyMatch = html.match(/class="Body-module[^"]*"[^>]*data-theme="[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/i);
  if (bodyMatch) {
    content = bodyMatch[1];
  } else {
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) content = articleMatch[1];
  }
  
  // Clean
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
  
  // Images
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
  const imgRegex = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let result = content;
  
  const matches = [...content.matchAll(imgRegex)];
  for (const match of matches) {
    const originalSrc = match[1];
    const base64 = downloadedImages[originalSrc];
    if (base64) {
      result = result.replace(match[0], `<img src="${base64}" alt=""/>`);
    } else {
      result = result.replace(match[0], '');
    }
  }
  
  return result;
}

async function main() {
  console.log('📚 Anthropic Articles EPUB Compiler\n');
  
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  console.log(`Found ${files.length} articles\n`);
  
  const articles = [];
  const seenTitles = new Set();
  
  for (const file of files) {
    try {
      const article = extractArticle(path.join(ARTICLES_DIR, file));
      const normalizedTitle = article.title.toLowerCase().trim();
      if (seenTitles.has(normalizedTitle)) {
        console.log(`⏭️  Skip duplicate: ${article.title.substring(0, 40)}`);
        continue;
      }
      seenTitles.add(normalizedTitle);
      
      if (article.content.length > 500) {
        articles.push(article);
        console.log(`✓ [${article.category}] ${article.title.substring(0, 45)}`);
      }
    } catch (e) {
      console.log(`✗ ${file}: ${e.message}`);
    }
  }
  
  console.log(`\n📥 Downloading images...`);
  
  const allImages = new Set();
  for (const article of articles) {
    for (const img of article.images) allImages.add(img);
  }
  
  const downloadedImages = {};
  let downloaded = 0;
  for (const imgUrl of allImages) {
    const base64 = await downloadImage(imgUrl);
    if (base64) {
      downloadedImages[imgUrl] = base64;
      downloaded++;
    }
    process.stdout.write(`\r  ${downloaded}/${allImages.size} images`);
  }
  console.log('\n');
  
  // Sort by category then date
  const categoryOrder = { 'Research': 1, 'Engineering': 2, 'News': 3 };
  articles.sort((a, b) => {
    const catDiff = (categoryOrder[a.category] || 4) - (categoryOrder[b.category] || 4);
    if (catDiff !== 0) return catDiff;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  
  console.log('📖 Building EPUB...');
  
  // Build chapters
  const chapters = [];
  let currentCategory = '';
  
  for (const article of articles) {
    // Category separator
    if (article.category !== currentCategory) {
      currentCategory = article.category;
      chapters.push({
        title: `— ${currentCategory} —`,
        content: `<h1 style="text-align:center; color:#d4af37;">${currentCategory}</h1>
                  <p style="text-align:center; color:#666;">Section ${categoryOrder[currentCategory]} of 3</p>`
      });
    }
    
    const processedContent = await processImages(article.content, downloadedImages);
    
    chapters.push({
      title: article.title,
      content: `
        <h1>${article.title}</h1>
        ${article.date ? `<p style="color:#666; font-size:0.9em;">${article.date}</p>` : ''}
        <hr/>
        ${processedContent}
      `
    });
  }
  
  const epubBuffer = await epub({
    title: 'Anthropic Articles Collection 2026',
    author: 'Anthropic',
    publisher: 'Anthropic',
    description: `${articles.length} articles from Anthropic's Research, Engineering, and News sections. Compiled February 2026.`,
    tocTitle: 'Contents',
    css: `
      body { font-family: Georgia, serif; line-height: 1.6; }
      h1 { color: #1a1a1a; margin-bottom: 0.5em; }
      h2, h3 { color: #333; }
      img { max-width: 100%; height: auto; display: block; margin: 1em auto; }
      p { margin: 1em 0; text-align: justify; }
      pre, code { background: #f5f5f5; padding: 0.5em; font-size: 0.9em; overflow-wrap: break-word; }
      blockquote { border-left: 3px solid #d4af37; padding-left: 1em; margin: 1em 0; font-style: italic; }
      a { color: #0066cc; }
      hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
    `
  }, chapters);
  
  const outputPath = path.join(OUTPUT_DIR, 'anthropic-articles-2026.epub');
  fs.writeFileSync(outputPath, epubBuffer);
  
  console.log(`\n✅ Done!`);
  console.log(`📄 Output: ${outputPath}`);
  console.log(`📊 Total: ${articles.length} articles in ${chapters.length} chapters`);
  console.log(`🖼️  Images: ${downloaded} embedded`);
  console.log(`📦 Size: ${(epubBuffer.length / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(console.error);
