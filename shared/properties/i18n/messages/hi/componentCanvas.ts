// Hindi `componentCanvas` strings. Held to English's keys by the compiler and to its placeholders by the parity test.
import type { CatalogOf } from '../../../../core/i18n/catalog';
import type { MessageKey } from '../en/componentCanvas';

export const messages = {
  'componentCanvas.error.busy': 'कैनवास खोलने से पहले डिफ़ॉल्ट एडिटर बंद करें।',
  'componentCanvas.error.notOpened': 'कंपोनेंट कैनवास पर नहीं खुला। फिर कोशिश करें।',
  'componentCanvas.error.notReturned': 'जिस फ़ाइल पर आप थे, उस पर वापस नहीं जा सके। उसे पेज पैनल से खोलें।',
  'componentCanvas.error.open': 'कैनवास नहीं खुल सका: {message}',
  'componentCanvas.error.save': 'कैनवास सेटिंग सहेजी नहीं जा सकीं: {message}',
  'componentCanvas.frame.part': '{prop}: {value}', // same
  'componentCanvas.frame.unset': 'सेट नहीं है',
  'componentCanvas.menu.open': 'कैनवास में खोलें',
  'componentCanvas.notice.truncated': '{total} में से पहले {shown} फ़्रेम दिखाए जा रहे हैं। बाकी देखने के लिए कम प्रॉप्स को अलग फ़्रेम दें।',
  'componentCanvas.pageName': '{name} कैनवास',
  'componentCanvas.panel.background': 'पृष्ठभूमि',
  'componentCanvas.panel.fixed': 'स्थिर',
  'componentCanvas.panel.frame.hint':
    'फ़्रेम चुनने के लिए उसके लेबल या उसके कंपोनेंट के आसपास की खाली जगह पर क्लिक करें। कंपोनेंट को संपादित करने के लिए उसके अंदर क्लिक करें।',
  'componentCanvas.panel.frame.pick': 'फ़्रेम',
  'componentCanvas.panel.frame.title': 'फ़्रेम',
  'componentCanvas.panel.frames': {
    one: '{count} फ़्रेम',
    other: '{count} फ़्रेम',
  },
  'componentCanvas.panel.height': 'ऊँचाई',
  'componentCanvas.panel.hug': 'कंटेंट के अनुसार',
  'componentCanvas.panel.pixels': '{side} पिक्सेल में',
  'componentCanvas.panel.props.hint':
    'वे मान जिनसे यह फ़्रेम रेंडर होता है। ये मान कैनवास पर बने रहते हैं और हर बार कैनवास खोलने पर वापस आते हैं। इन्हें कंपोनेंट या उसके इंस्टेंस में कभी नहीं लिखा जाता।',
  'componentCanvas.panel.props.none': 'सेट नहीं है',
  'componentCanvas.panel.props.split': '{name} के हर मान का अपना फ़्रेम है।',
  'componentCanvas.panel.props.title': 'प्रीव्यू प्रॉप्स',
  'componentCanvas.panel.props.unused': 'यह वेरिएंट {name} का इस्तेमाल नहीं करता।',
  'componentCanvas.panel.scope.all': 'सभी फ़्रेम',
  'componentCanvas.panel.scope.frame': 'यह फ़्रेम',
  'componentCanvas.panel.scope.hint':
    'आपके सेट किए गए आकार, पृष्ठभूमि और प्रॉप मान कहाँ लागू हों: इस फ़्रेम पर, किसी एक मान के हर फ़्रेम पर, या हर फ़्रेम पर। फ़्रेम की अपनी सेटिंग ज़्यादा व्यापक सेटिंग से ऊपर रहती है।',
  'componentCanvas.panel.scope.label': 'इस पर लागू करें',
  'componentCanvas.panel.scope.part': 'हर {part} फ़्रेम',
  'componentCanvas.panel.split.hint':
    'यहाँ चालू की गई प्रॉप के हर मान को अपना फ़्रेम मिलता है, और फ़्रेम हर संयोजन दिखाते हैं। बंद छोड़ी गई प्रॉप हर फ़्रेम में एक ही मान दिखाती है, जिसे आप प्रीव्यू प्रॉप्स में सेट करते हैं।',
  'componentCanvas.panel.split.title': 'अलग फ़्रेम',
  'componentCanvas.panel.split.toggle': '{name} के हर मान को अपना फ़्रेम दें',
  'componentCanvas.panel.transparent': 'पारदर्शी',
  'componentCanvas.panel.values': {
    one: '{count} मान',
    other: '{count} मान',
  },
  'componentCanvas.panel.width': 'चौड़ाई',
  'componentCanvas.popup.close': 'फ़्रेम सेटिंग्स बंद करें',
  'componentCanvas.popup.title': 'फ़्रेम सेटिंग्स',
  'componentCanvas.titleBar.close': '{name} कैनवास बंद करें',
  'componentCanvas.zoom.fit': 'फ़िट',
  'componentCanvas.zoom.fitAll': 'सभी फ़्रेम फ़िट करने के लिए ज़ूम करें',
  'componentCanvas.zoom.in': 'ज़ूम इन',
  'componentCanvas.zoom.out': 'ज़ूम आउट',
  'componentCanvas.zoom.percent': '{percent}%', // same
  'componentCanvas.zoom.reset': '100% पर ज़ूम करें',
} as const satisfies CatalogOf<MessageKey>;
