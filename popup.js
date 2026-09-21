const durationSelect = document.getElementById('duration');
const exportBtn = document.getElementById('export-btn');

const DURATION_LABELS = { 'today': "Export Today's Chat", 'yesterday': "Export Yesterday's Chat", '3': 'Export Last 3 Days', '7': 'Export Last 7 Days', 'all': 'Export Entire Chat' };

function labelForDuration() {
  const val = durationSelect.value;
  return DURATION_LABELS[val] || `Export Last ${val} Days`;
}

function resetButtonLabel() {
  exportBtn.textContent = labelForDuration();
}

durationSelect.addEventListener('change', resetButtonLabel);
resetButtonLabel(); // sync label if the browser restored a non-default selection

exportBtn.addEventListener('click', async () => {
  const format = document.getElementById('format').value;
  const days = durationSelect.value;
  const errorMsg = document.getElementById('error-msg');

  errorMsg.style.display = 'none';

  // Get active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes('web.whatsapp.com')) {
    errorMsg.style.display = 'block';
    return;
  }

  exportBtn.textContent = 'Exporting...';
  exportBtn.style.opacity = '0.7';
  exportBtn.disabled = true;

  try {
    await chrome.tabs.sendMessage(tab.id, {
      target: 'content',
      type: 'export_chat',
      format: format,
      days: days,
    });

    // Close the popup shortly after initiating export
    setTimeout(() => {
      window.close();
    }, 1000);
  } catch (err) {
    errorMsg.textContent = 'Error: Please refresh the WhatsApp tab and try again.';
    errorMsg.style.display = 'block';
    resetButtonLabel();
    exportBtn.style.opacity = '1';
    exportBtn.disabled = false;
  }
});
