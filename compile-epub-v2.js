const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const epub = require('epub-gen-memory').default;

const ARTICLES_DIR = path.join(__dirname, 'full-articles');
const OUTPUT_DIR = path.join(__dirname, 'articles-output');
const IMAGES_DIR = path.join(OUTPUT_DIR, 'epub-images');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Download image and save to disk, return file:// URL
async function downloadImage(url, index) {
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
        downloadImage(res.headers.location, index).then(resolve);
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
        const ext = contentType.includes('png') ? '.png' : contentType.includes('gif') ? '.gif' : contentType.includes('svg') ? '.svg' : '.jpg';
        const filename = `img-${index}${ext}`;
        const filePath = path.join(IMAGES_DIR, filename);
        fs.writeFileSync(filePath, buffer);
        resolve(`file://${filePath}`);
      });
      res.on('error', () => { clearTimeout(timeout); resolve(null); });
    }).on('error', () => { clearTimeout(timeout); resolve(null); });
  });
}

// Extract article content
function extractArticle(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const filename = path.basename(htmlPath, '.html');
  
  let title = filename.replace(/-/g, ' ').replace(/^(eng|news|research)\s*/i, '');
  const titleMatch = html.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)</i) ||
                     html.match(/<title>([^<\\]+)/i);
  if (titleMatch) {
    title = titleMatch[1].trim().replace(/\s*\\\s*Anthropic/g, '').replace(/\s*\|\s*Anthropic/g, '');
  }
  
  let date = '';
  const dateMatch = html.match(/class="[^"]*agate[^"]*"[^>]*>([A-Z][a-z]+ \d+, \d{4})/i) ||
                    html.match(/>([A-Z][a-z]+ \d+, 20\d{2})</);
  if (dateMatch) date = dateMatch[1];
  
  let category = 'News';
  if (filename.startsWith('eng-')) category = 'Engineering';
  else if (filename.startsWith('research-')) category = 'Research';
  
  let content = '';
  const bodyMatch = html.match(/class="Body-module[^"]*"[^>]*data-theme="[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/article>/i);
  if (bodyMatch) {
    content = bodyMatch[1];
  } else {
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) content = articleMatch[1];
  }
  
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

async function main() {
  console.log('📚 Anthropic Articles EPUB Compiler v2\n');
  
  // Clear old images
  fs.readdirSync(IMAGES_DIR).forEach(f => fs.unlinkSync(path.join(IMAGES_DIR, f)));
  
  const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.html'));
  console.log(`Found ${files.length} articles\n`);
  
  const articles = [];
  const seenTitles = new Set();
  
  for (const file of files) {
    try {
      const article = extractArticle(path.join(ARTICLES_DIR, file));
      const normalizedTitle = article.title.toLowerCase().trim();
      if (seenTitles.has(normalizedTitle)) {
        console.log(`⏭️  Skip: ${article.title.substring(0, 40)}`);
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
  
  // Download all images and create mapping
  const imageMap = {};
  let imgIndex = 0;
  let downloaded = 0;
  
  for (const article of articles) {
    for (const imgUrl of article.images) {
      if (!imageMap[imgUrl]) {
        const localPath = await downloadImage(imgUrl, imgIndex++);
        if (localPath) {
          imageMap[imgUrl] = localPath;
          downloaded++;
        }
        process.stdout.write(`\r  ${downloaded} images downloaded`);
      }
    }
  }
  console.log('\n');
  
  // Sort by category
  const categoryOrder = { 'Research': 1, 'Engineering': 2, 'News': 3 };
  articles.sort((a, b) => {
    const catDiff = (categoryOrder[a.category] || 4) - (categoryOrder[b.category] || 4);
    if (catDiff !== 0) return catDiff;
    return new Date(b.date || 0) - new Date(a.date || 0);
  });
  
  console.log('📖 Building EPUB...');
  
  const chapters = [];
  let currentCategory = '';
  
  for (const article of articles) {
    if (article.category !== currentCategory) {
      currentCategory = article.category;
      chapters.push({
        title: `— ${currentCategory} —`,
        content: `<h1 style="text-align:center;">${currentCategory}</h1>`
      });
    }
    
    // Replace image URLs with local file paths
    let processedContent = article.content;
    for (const [origUrl, localPath] of Object.entries(imageMap)) {
      if (localPath) {
        processedContent = processedContent.split(origUrl).join(localPath);
      }
    }
    // Remove any remaining img tags that didn't get replaced
    processedContent = processedContent.replace(/<img[^>]+src="(?!file:\/\/)[^"]*"[^>]*>/gi, '');
    
    chapters.push({
      title: article.title,
      content: `
        <h1>${article.title}</h1>
        ${article.date ? `<p><em>${article.date}</em></p>` : ''}
        <hr/>
        ${processedContent}
      `
    });
  }
  
  const epubBuffer = await epub({
    title: 'Anthropic Articles Collection 2026',
    author: 'Anthropic',
    publisher: 'Anthropic',
    description: `${articles.length} articles from Anthropic's Research, Engineering, and News. Compiled Feb 2026.`,
    tocTitle: 'Contents',
    css: `
      body { font-family: Georgia, serif; line-height: 1.6; }
      h1 { margin-bottom: 0.5em; }
      img { max-width: 100%; height: auto; }
      p { margin: 1em 0; }
      pre, code { background: #f5f5f5; padding: 0.5em; font-size: 0.9em; }
      blockquote { border-left: 3px solid #999; padding-left: 1em; font-style: italic; }
      hr { border: none; border-top: 1px solid #ccc; margin: 2em 0; }
    `
  }, chapters);
  
  const outputPath = path.join(OUTPUT_DIR, 'anthropic-articles-2026.epub');
  fs.writeFileSync(outputPath, epubBuffer);
  
  console.log(`\n✅ Done!`);
  console.log(`📄 Output: ${outputPath}`);
  console.log(`📊 ${articles.length} articles, ${chapters.length} chapters`);
  console.log(`🖼️  ${downloaded} images`);
  console.log(`📦 ${(epubBuffer.length / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(console.error);
