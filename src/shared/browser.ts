// The only place that imports the WebExtension API, so a Chrome port has one seam to change.
import browser from 'webextension-polyfill';

export default browser;
export type { Runtime, Storage, Tabs } from 'webextension-polyfill';
