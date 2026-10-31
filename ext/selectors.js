// Default CSS selectors for the Venice chat page.
// These are GUESSES: the page markup was not available when this was written.
// Calibrate them from the panel ("Kalibrasi") or the options page before the first run.
globalThis.VB_DEFAULT_SELECTORS = {
  // The message box you type into (textarea or contenteditable).
  input: 'textarea, [contenteditable="true"][role="textbox"]',
  // Button that sends the message. If none matches, Enter is pressed instead.
  sendButton: 'button[type="submit"], button[aria-label*="send" i]',
  // Visible only while the model is still generating.
  stopButton: 'button[aria-label*="stop" i]',
  // One element per ASSISTANT reply (not user messages).
  assistantMessage: '[data-message-author-role="assistant"], [data-role="assistant"]',
  // Parts inside a reply to ignore, e.g. the collapsible "thinking" block of reasoning
  // models. Kept specific on purpose: a bare "details" would also strip legitimate
  // <details> the model writes into the answer. Calibrate if Venice uses a plain <details>.
  excludeInMessage: '[data-reasoning], [class*="reasoning" i], [class*="thinking" i], details[class*="reason" i], details[class*="think" i]',
  // Starts a new chat without reloading the page.
  newChatButton: 'a[href="/chat"], button[aria-label*="new chat" i]',
  // Shows the name of the active model.
  modelLabel: '[aria-label*="model" i]',
  // Entries in the model picker after it is opened.
  modelOption: '[role="option"], [role="menuitem"]'
};
