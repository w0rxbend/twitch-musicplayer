import { createRoot, createSignal } from 'solid-js';

const { hintText, showHint } = createRoot(() => {
  const [text, setText] = createSignal('');
  let _timer: ReturnType<typeof setTimeout> | undefined;
  return {
    hintText: text,
    showHint(msg: string, ms = 3200) {
      setText(msg);
      clearTimeout(_timer);
      _timer = setTimeout(() => setText(''), ms);
    },
  };
});

export { hintText, showHint };
