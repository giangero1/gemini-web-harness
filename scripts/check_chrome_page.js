const http = require('http');

async function getGeminiPageWsUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://[::1]:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          const page = list.find(p => p.type === 'page' && p.url.includes('gemini.google.com'));
          if (page && page.webSocketDebuggerUrl) {
            resolve(page.webSocketDebuggerUrl);
          } else {
            reject(new Error('No gemini.google.com page found in Chrome'));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  try {
    const wsUrl = await getGeminiPageWsUrl();
    console.log('Connecting to:', wsUrl);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `({
            title: document.title,
            url: window.location.href,
            bodyText: (document.body ? document.body.innerText.substring(0, 500).replace(/\\n+/g, ' ') : ''),
            hasPromptInput: Boolean(document.querySelector('rich-textarea div[contenteditable="true"]') || document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea')),
            recentChats: Array.from(document.querySelectorAll('.conversation-item, [data-test-id="conversation-title"], nav a')).map(a => a.innerText || a.textContent).filter(Boolean).slice(0, 10)
          })`,
          returnByValue: true
        }
      }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id === 1) {
        console.log('CHROME GEMINI STATE:', JSON.stringify(data.result?.result?.value, null, 2));
        ws.close();
        process.exit(0);
      }
    };
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
