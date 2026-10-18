import { expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { RecoveryCodes } from './RecoveryCodes';

it('gates Continue behind the "I saved them" checkbox', async () => {
  const onDone = vi.fn();
  renderWithProviders(<RecoveryCodes codes={['aaaa-1111', 'bbbb-2222']} onDone={onDone} />);
  expect(screen.getByText('aaaa-1111')).toBeInTheDocument();
  const btn = screen.getByRole('button', { name: 'Continue' });
  expect(btn).toBeDisabled();
  await userEvent.click(btn);
  expect(onDone).not.toHaveBeenCalled();
  await userEvent.click(screen.getByLabelText(/I saved these codes/));
  expect(btn).toBeEnabled();
  await userEvent.click(btn);
  expect(onDone).toHaveBeenCalledTimes(1);
});
