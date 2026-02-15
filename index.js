/**
 * Anthropic Article Sender - WITH IMAGE SUPPORT
 * Checks for new Anthropic blog articles and sends them to Kindle
 * 
 * Usage: node index.js
 * Cron: 0 9 * * * /opt/homebrew/bin/node /Users/shuang/Projects/anthropic-sender/index.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CONFIG = {
  KINDLE_EMAIL: 'liushuanguni_1IPvlo@kindle.com',
  NOTIFICATION_EMAIL: 'liushuanguni@gmail.com',
  DATA_FILE: path.join(__dirname, 'sent-articles.json'),
  ARTICLES_DIR: path.join(__dirname, 'articles'),
  IMAGES_DIR: path.join(__dirname, 'images')
};

// Ensure directories exist
[CONFIG.ARTICLES_DIR, CONFIG.IMAGES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Load previously sent articles
function loadSentArticles() {
  try {
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading sent articles:', e);
  }
  return { sent: [], lastCheck: null };
}

// Save sent articles
function saveSentArticles(data) {
  fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
}

// Download file (images)
function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const request = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    }, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, filepath)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      const file = fs.createWriteStream(filepath);
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(filepath);
      });
    });
    
    request.on('error', reject);
  });
}

// Extract images from HTML
function extractImages(html, baseUrl) {
  const images = [];
  const imgRegex = /<img[^>]+src="([^"]+)"/gi;
  const pictureRegex = /<picture[^>]*>[\s\S]*?<source[^>]+srcset="([^"]+)"/gi;
  
  let match;
  
  // Match <img> tags
  while ((match = imgRegex.exec(html)) !== null) {
    let src = match[1];
    if (src.startsWith('//')) {
      src = 'https:' + src;
    } else if (src.startsWith('/')) {
      src = baseUrl + src;
    }
    
    if (src.startsWith('http') && !src.includes('data:')) {
      // Skip tracking pixels and icons
      if (!src.includes('pixel') && !src.includes('icon') && !src.includes('logo')) {
        images.push({ src, alt: 'image' });
      }
    }
  }
  
  // Match <picture> sources
  while ((match = pictureRegex.exec(html)) !== null) {
    let src = match[1];
    if (src.startsWith('//')) {
      src = 'https:' + src;
    }
    
    if (src.startsWith('http')) {
      images.push({ src, alt: 'image' });
    }
  }
  
  return images;
}

// Fetch URL content
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    }, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        fetchUrl(res.headers.location).then(resolve).catch(reject);
        return;
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Extract articles from Anthropic pages
function extractArticles(html, source) {
  const articleUrls = new Set();
  const urlRegex = /href="(https:\/\/www\.anthropic\.com\/[^"]+)"/g;
  
  let match;
  while ((match = urlRegex.exec(html)) !== null) {
    const url = match[1];
    if (url.includes('/news/') || url.includes('/engineering/') || url.includes('/research/')) {
      articleUrls.add(url);
    }
  }
  
  return Array.from(articleUrls).slice(0, 3); // Limit to 3 articles
}

// Send email via macOS Mail
function sendEmail(to, subject, body, attachmentPath = null) {
  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    
    let script = `
      tell application "Mail"
        set msg to make new outgoing message with properties {subject:"${subject}", content:"${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"}
        tell msg
          make new to recipient at end of to recipients with properties {address:"${to}"}
        end tell
    `;
    
    if (attachmentPath && fs.existsSync(attachmentPath)) {
      script += `
        tell content of msg
          make new attachment with properties {file name:"${attachmentPath}"}
        end tell
      `;
    }
    
    script += `
        send msg
      end tell
    `;
    
    exec(`osascript -e '${script}'`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve(true);
      }
    });
  });
}

// Download and process article as HTML
async function downloadArticle(url, articleDir) {
  try {
    const html = await fetchUrl(url);
    
    // Extract title
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';
    
    // Extract images
    const images = extractImages(html, 'https://www.anthropic.com');
    console.log(`   📷 Found ${images.length} images`);
    
    // Download images
    const downloadedImages = [];
    for (let i = 0; i < Math.min(images.length, 5); i++) {
      const img = images[i];
      const ext = img.src.split('?')[0].split('.').pop() || 'jpg';
      const imgFilename = `image-${i + 1}.${ext}`;
      const imgPath = path.join(articleDir, imgFilename);
      
      try {
        await downloadFile(img.src, imgPath);
        downloadedImages.push({ local: imgFilename, original: img.src });
        console.log(`   ✅ Downloaded: ${imgFilename}`);
      } catch (e) {
        console.log(`   ❌ Failed to download: ${img.src}`);
      }
    }
    
    // Extract main content
    let contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || 
                      html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                      html.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    
    let content = contentMatch ? contentMatch[1] : html;
    
    // Replace image src with local paths in content
    for (const img of downloadedImages) {
      let escapedOriginal = img.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      content = content.replace(new RegExp(escapedOriginal), img.local);
    }
    
    // Clean up HTML - keep useful tags
    content = content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
      .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
      .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '');
    
    return { title, content, url, images: downloadedImages };
  } catch (e) {
    console.error('Error downloading article:', e.message);
    return null;
  }
}

// Create HTML file for Kindle
function createHtmlFile(title, articles, dateStr) {
  let html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #333; padding-bottom: 10px; }
    h2 { color: #333; margin-top: 30px; }
    img { max-width: 100%; height: auto; margin: 10px 0; }
    p { line-height: 1.6; color: #333; }
    a { color: #0066cc; }
    .article { margin-bottom: 40px; border-bottom: 1px solid #ccc; padding-bottom: 20px; }
    .source { color: #666; font-size: 0.9em; }
    .date { color: #666; font-size: 0.9em; margin-bottom: 20px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <p class="date">${dateStr}</p>
`;

  for (const article of articles) {
    if (!article.data) continue;
    
    html += `
  <div class="article">
    <h2>${article.data.title}</h2>
    ${article.data.content}
    <p class="source">Source: <a href="${article.data.url}">${article.data.url}</a></p>
  </div>
`;
  }

  html += `
</body>
</html>`;

  return html;
}

// Main function
async function main() {
  console.log('🔍 Checking for new Anthropic articles...');
  
  const data = loadSentArticles();
  const sentUrls = new Set(data.sent.map(a => a.url));
  
  const pages = [
    { url: 'https://www.anthropic.com/news', source: 'news' },
    { url: 'https://www.anthropic.com/engineering', source: 'engineering' },
    { url: 'https://www.anthropic.com/research', source: 'research' }
  ];
  
  let newArticles = [];
  
  for (const page of pages) {
    try {
      console.log(`📄 Checking ${page.source}...`);
      const html = await fetchUrl(page.url);
      const articles = extractArticles(html, page.source);
      
      for (const url of articles) {
        if (!sentUrls.has(url)) {
          console.log(`   ✅ New article found: ${url}`);
          newArticles.push(url);
        }
      }
    } catch (e) {
      console.error(`   ❌ Error fetching ${page.source}:`, e.message);
    }
  }
  
  if (newArticles.length === 0) {
    console.log('✅ No new articles found.');
    data.lastCheck = new Date().toISOString();
    saveSentArticles(data);
    return;
  }
  
  console.log(`\n📦 Found ${newArticles.length} new articles!`);
  
  // Create dated folder for this batch
  const dateStr = new Date().toISOString().split('T')[0];
  const batchDir = path.join(CONFIG.ARTICLES_DIR, dateStr);
  if (!fs.existsSync(batchDir)) {
    fs.mkdirSync(batchDir, { recursive: true });
  }
  
  // Download and process each article
  const processedArticles = [];
  
  for (const url of newArticles) {
    console.log(`📥 Downloading: ${url}`);
    const articleDir = path.join(batchDir, `article-${processedArticles.length}`);
    fs.mkdirSync(articleDir, { recursive: true });
    
    const articleData = await downloadArticle(url, articleDir);
    
    if (articleData) {
      processedArticles.push({ url, data: articleData });
      
      data.sent.push({
        url: url,
        title: articleData.title,
        date: new Date().toISOString()
      });
    }
  }
  
  if (processedArticles.length === 0) {
    console.log('❌ No articles could be downloaded.');
    return;
  }
  
  // Create HTML file
  const htmlContent = createHtmlFile(
    'Anthropic Articles',
    processedArticles,
    new Date().toLocaleDateString()
  );
  
  const htmlFilename = `anthropic-articles-${dateStr}.html`;
  const htmlPath = path.join(CONFIG.ARTICLES_DIR, htmlFilename);
  fs.writeFileSync(htmlPath, htmlContent);
  console.log(`💾 Saved HTML: ${htmlPath}`);
  
  // Send to Kindle
  console.log(`\n📧 Sending to Kindle (${CONFIG.KINDLE_EMAIL})...`);
  await sendEmail(
    CONFIG.KINDLE_EMAIL,
    'Anthropic Articles with Images',
    `Latest Anthropic articles with images:\n\n${processedArticles.map(a => `- ${a.data.title}`).join('\n')}`,
    htmlPath
  );
  console.log('✅ Sent to Kindle!');
  
  // Send confirmation
  console.log(`📧 Sending confirmation to ${CONFIG.NOTIFICATION_EMAIL}...`);
  await sendEmail(
    CONFIG.NOTIFICATION_EMAIL,
    '✅ Anthropic Articles Sent to Kindle',
    `Sent ${processedArticles.length} Anthropic articles to your Kindle.\n\nArticles:\n${processedArticles.map(a => `- ${a.data.title}`).join('\n')}\n\nFile: ${htmlPath}`
  );
  console.log('✅ Confirmation sent!');
  
  // Save sent articles
  data.lastCheck = new Date().toISOString();
  saveSentArticles(data);
  
  console.log('✅ Done!');
}

main().catch(console.error);
