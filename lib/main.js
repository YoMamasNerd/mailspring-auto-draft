const { ComponentRegistry, PreferencesUIStore } = require('mailspring-exports');
const AiDraftPanel = require('./ai-draft-panel');
const AiDraftPreferences = require('./preferences');

let prefTab = null;

module.exports = {
  activate() {
    ComponentRegistry.register(AiDraftPanel, { role: 'Composer:Footer' });

    prefTab = new PreferencesUIStore.TabItem({
      tabId: 'AI Drafts',
      displayName: 'AI Drafts',
      componentClassFn: () => AiDraftPreferences,
    });
    PreferencesUIStore.registerPreferencesTab(prefTab);
  },

  deactivate() {
    ComponentRegistry.unregister(AiDraftPanel);
    if (prefTab) {
      PreferencesUIStore.unregisterPreferencesTab(prefTab.tabId);
      prefTab = null;
    }
  },
};
