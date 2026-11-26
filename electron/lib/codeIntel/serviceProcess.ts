// The intelligence process: main starts it as an Electron utility process the first time a code file is opened, so
// reading a project's types can never stall the window or the preview, and a crash or a runaway project ends only
// this process. One message in is one reply out, each parsed on both sides.
import { parseCodeIntelRequest, UNAVAILABLE, type CodeIntelReply } from '../../../shared/ipc/codeIntel';
import { parseServiceMessage, type ServiceAnswer } from './messages';
import { createCodeIntelService } from './service';

const service = createCodeIntelService();

function reply(id: number, answer: CodeIntelReply): void {
  const message: ServiceAnswer = { id, reply: answer };
  process.parentPort.postMessage(message);
}

process.parentPort.on('message', (event: { readonly data: unknown }) => {
  const message = parseServiceMessage(event.data);
  try {
    reply(message.id, service.handle(parseCodeIntelRequest(message.request)));
  } catch (error: unknown) {
    // A question that breaks the reader is answered empty; the next one starts from the files again.
    console.error('[code intelligence]', error instanceof Error ? (error.stack ?? error.message) : String(error));
    service.dispose();
    reply(message.id, UNAVAILABLE);
  }
});
