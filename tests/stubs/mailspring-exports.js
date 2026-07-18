// Minimaler Stub der Mailspring-API, damit die Plugin-Module außerhalb von
// Mailspring geladen und getestet werden können. Nur die Oberflächen, die
// lib/ tatsächlich beim Laden bzw. in den Tests anfasst.

class Component {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
  setState(partial, callback) {
    Object.assign(this.state, typeof partial === 'function' ? partial(this.state) : partial);
    if (callback) callback();
  }
}

const React = {
  Component,
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
};

// PropTypes-Zugriffe (object.isRequired etc.) sollen einfach nie werfen.
const anyValidator = () => null;
anyValidator.isRequired = anyValidator;
const PropTypes = new Proxy({}, { get: () => anyValidator });

module.exports = {
  React,
  PropTypes,
  Actions: {
    openPreferences: () => {},
    switchPreferencesTab: () => {},
  },
  ComponentRegistry: {
    register: () => {},
    unregister: () => {},
  },
  PreferencesUIStore: {
    TabItem: class TabItem {
      constructor(opts) {
        Object.assign(this, opts);
      }
    },
    registerPreferencesTab: () => {},
    unregisterPreferencesTab: () => {},
  },
  DatabaseStore: {
    findAll: () => ({
      where: () => Promise.resolve([]),
    }),
  },
  Message: {},
  QuotedHTMLTransformer: {
    removeQuotedHTML: (html) => html,
  },
};
