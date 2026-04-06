const KEY = "AIzaSyC21XaJPfbRwwHaOZ_7nN79EWmcNIYFuM0";
const url = "https://gateway.ai.cloudflare.com/v1/6619e512bf454ca21f69bd1663737deb/jellyfish-gateway/google-ai-studio/v1beta/models/gemini-2.5-flash:generateContent";

const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
  body: JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: 'test 1 2 3' }] }]
  })
});
const text = await res.text();
console.log("Status:", res.status);
console.log("Response:", text.substring(0, 100));
