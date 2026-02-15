/**
 * Anthropic Article Sender
 * Checks for new Anthropic blog articles and sends them to Kindle
 * 
 * Usage: node index.js
 * Cron: 0 9 * * * /opt/homebrew/bin/node /Users/shuang/Projects/anthropic-sender/index.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG = {
  KINDLE_EMAIL: 'liushuanguni_1IPvlo@kindle.com',
  NOTIFICATION_EMAIL: 'liushuanguni@gmail.com',
  DATA_FILE: path.join(__dirname, 'sent-articles.json'),
  ARTICLES_FILE: path.join(__dirname, 'articles')
};

// Ensure articles directory exists
if (!fs.existsSync(CONFIG.ARTICLES_FILE)) {
  fs.mkdirSync(CONFIG.ARTICLES_FILE, { recursive: true });
}

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

// Fetch URL content
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Extract articles from Anthropic pages
function extractArticles(html, source) {
  const articles = [];
  const urlRegex = /href="(https:\/\/www\.anthropic\.com\/[^"]+)"/g;
  const titleRegex = /<h[123][^>]*>([^<]+)<\/h[123]>/gi;
  
  // Simple extraction - find article links
  const articleUrls = new Set();
  let match;
  while ((match = urlRegex.exec(html)) !== null) {
    const url = match[1];
    if (url.includes('/news/') || url.includes('/engineering/') || url.includes('/research/')) {
      articleUrls.add(url);
    }
  }
  
  return Array.from(articleUrls).slice(0, 5); // Limit to 5 articles
}

// Send email via macOS Mail
function sendEmail(to, subject, body, attachmentPath = null) {
  return new Promise((resolve, reject) => {
    let script = `
      tell application "Mail"
        set msg to make new outgoing message with properties {subject:"${subject}", content:"${body.replace(/"/g, '\\"')}"}
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
    
    const { exec } = require('child_process');
    exec(`osascript -e '${script}'`, (error, stdout, stderr) => {
      if (error) {
        console.error('Mail error:', stderr);
        reject(error);
      } else {
        resolve(true);
      }
    });
  });
}

// Download article as text
async function downloadArticle(url) {
  try {
    const html = await fetchUrl(url);
    
    // Extract title
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1] : 'Untitled';
    
    // Extract main content (simple approach)
    const contentMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) || html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    let content = contentMatch ? contentMatch[1] : html;
    
    // Remove HTML tags
    content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    content = content.replace(/<[^>]+>/g, '\n');
    content = content.replace(/\n\s*\n/g, '\n\n');
    content = content.trim();
    
    // Limit content size
    if (content.length > 50000) {
      content = content.substring(0, 50000) + '\n\n...(truncated)';
    }
    
    return { title, content, url };
  } catch (e) {
    console.error('Error downloading article:', e.message);
    return null;
  }
}

// Main function
async function main() {
  console.log('🔍 Checking for new Anthropic articles...');
  
  const data = loadSentArticles();
  const sentUrls = new Set(data.sent.map(a => a.url));
  
  // Fetch Anthropic pages
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
  
  // Download and compile articles
  let compiledContent = `# Anthropic Articles\n`;
  compiledContent += `## ${new Date().toLocaleDateString()}\n\n`;
  
  for (const url of newArticles) {
    console.log(`📥 Downloading: ${url}`);
    const article = await downloadArticle(url);
    
    if (article) {
      compiledContent += `\n---\n\n`;
      compiledContent += `# ${article.title}\n\n`;
      compiledContent += `${article.content}\n\n`;
      compiledContent += `Source: ${article.url}\n`;
      
      // Add to sent list
      data.sent.push({
        url: article.url,
        title: article.title,
        date: new Date().toISOString()
      });
    }
  }
  
  // Save compiled content
  const filename = `anthropic-articles-${new Date().toISOString().split('T')[0]}.txt`;
  const filepath = path.join(CONFIG.ARTICLES_FILE, filename);
  fs.writeFileSync(filepath, compiledContent);
  console.log(`💾 Saved to: ${filepath}`);
  
  // Send to Kindle
  console.log(`\n📧 Sending to Kindle (${CONFIG.KINDLE_EMAIL})...`);
  await sendEmail(
    CONFIG.KINDLE_EMAIL,
    'Anthropic Articles',
    `Here are the latest Anthropic articles:\n\n${newArticles.map(a => `- ${a}`).join('\n')}`,
    filepath
  );
  console.log('✅ Sent to Kindle!');
  
  // Send confirmation
  console.log(`📧 Sending confirmation to ${CONFIG.NOTIFICATION_EMAIL}...`);
  await sendEmail(
    CONFIG.NOTIFICATION_EMAIL,
    '✅ Anthropic Articles Sent to Kindle',
    `Sent ${newArticles.length} new Anthropic articles to your Kindle.\n\nArticles:\n${newArticles.map(a => `- ${a}`).join('\n')}\n\nSaved to: ${filepath}`
  );
  console.log('✅ Confirmation sent!');
  
  // Update sent articles
  data.lastCheck = new Date().toISOString();
  saveSentArticles(data);
  
  console.log('✅ Done!');
}

main().catch(console.error);
