// Read the bounded notifications emitted by the real component error bridge in feature tests.
exports.toastMessages = () => (globalThis.stackiCapturedToasts ?? []).map((item) => item.message).join('\n');
exports.toastNotices = () => globalThis.stackiCapturedToasts ?? [];
