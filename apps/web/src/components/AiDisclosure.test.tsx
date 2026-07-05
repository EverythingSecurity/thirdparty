import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiDisclosure } from './AiDisclosure';

describe('AiDisclosure', () => {
  it('renders the required disclosure text', () => {
    render(<AiDisclosure />);
    expect(screen.getByTestId('ai-disclosure')).toHaveTextContent(
      'AI-Generated — Human Review Required',
    );
  });

  it('renders in banner variant by default', () => {
    render(<AiDisclosure />);
    const el = screen.getByTestId('ai-disclosure');
    expect(el.className).toContain('border-y');
  });

  it('renders in inline variant when requested', () => {
    render(<AiDisclosure variant="inline" />);
    const el = screen.getByTestId('ai-disclosure');
    expect(el.className).toContain('inline-flex');
  });

  it('exposes an ARIA live region for screen readers', () => {
    render(<AiDisclosure />);
    expect(screen.getByTestId('ai-disclosure')).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByTestId('ai-disclosure')).toHaveAttribute('role', 'status');
  });

  it('does NOT render a dismiss control (contractual — blueprint §5.5)', () => {
    // The component's prop surface must not include an onClose / onDismiss —
    // this test protects that guarantee by checking the DOM has no button.
    render(<AiDisclosure />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
