import { hintText } from '../store/hint';

export function Hint() {
  return (
    <div id="hint" class={hintText() ? 'show' : ''}>
      {hintText()}
    </div>
  );
}
