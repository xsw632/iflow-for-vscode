import type { WebviewMessage } from "../../src/protocol";

export interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi();
  }
  return api;
}

export function postMessage(msg: WebviewMessage): void {
  getVsCodeApi().postMessage(msg);
}
