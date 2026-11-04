import { parseArchiveJob, type ArchiveParseJob } from "./catalog.ts";

declare const self: Worker;
self.onmessage = (event: MessageEvent<ArchiveParseJob>) => self.postMessage(parseArchiveJob(event.data));
