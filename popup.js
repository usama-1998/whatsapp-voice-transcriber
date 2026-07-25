document.getElementById('export-btn').addEventListener('click', async () => {
  const format = document.getElementById('format').value;
  const errorMsg = document.getElementById('error-msg');
  const btn = document.getElementById('export-btn');

  errorMsg.style.display = 'none';

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab || !tab.url || !tab.url.includes('web.whatsapp.com')) {
    errorMsg.style.display = 'block';
    return;
  }

  btn.textContent = 'Exporting...';
  btn.style.opacity = '0.7';
  btn.disabled = true;

  try {
    await chrome.tabs.sendMessage(tab.id, { 
      target: 'content', 
      type: 'export_chat_today',
      format: format 
    });
    
    // Close the popup shortly after initiating export
    setTimeout(() => {
      window.close();
    }, 1000);
  } catch (err) {
    errorMsg.textContent = 'Error: Please refresh the WhatsApp tab and try again.';
    errorMsg.style.display = 'block';
    btn.textContent = 'Export Today\'s Chat';
    btn.style.opacity = '1';
    btn.disabled = false;
  }
});
