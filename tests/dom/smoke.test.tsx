import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from '../../src/App'

describe('DOM harness smoke', () => {
  it('renders the app cold with no data', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /hydrograph metrics explorer/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Data' })).toBeInTheDocument();
  });
});
