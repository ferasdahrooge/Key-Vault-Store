/** Dialog focus behaviour: autofocus on open only, not on every re-render. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog } from './Dialog';

afterEach(cleanup);

// Two-field form whose parent passes a fresh inline onClose each render, like NewSecretDialog.
function Harness() {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  return (
    <Dialog open onClose={() => {}} title="Test">
      <input aria-label="first" value={a} onChange={(e) => setA(e.target.value)} data-autofocus />
      <input aria-label="second" value={b} onChange={(e) => setB(e.target.value)} />
    </Dialog>
  );
}

describe('Dialog', () => {
  // Regression: typing in a later field used to bounce focus back to the autofocus field.
  it('keeps focus in the field being typed into', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByLabelText('first')).toHaveFocus();

    await user.click(screen.getByLabelText('second'));
    await user.keyboard('abc');

    expect(screen.getByLabelText('second')).toHaveFocus();
    expect(screen.getByLabelText('second')).toHaveValue('abc');
  });
});
