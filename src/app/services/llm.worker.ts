/// <reference lib="webworker" />
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

/**
 * Web Worker que hospeda o engine do WebLLM.
 *
 * Rodar o modelo num worker dedicado evita travar a UI durante o download do
 * modelo e a inferência (WebGPU). A thread principal fala com este worker via
 * `CreateWebWorkerMLCEngine` (ver LlmAnalysisService).
 */
const handler = new WebWorkerMLCEngineHandler();

self.onmessage = (msg: MessageEvent): void => {
  handler.onmessage(msg);
};
