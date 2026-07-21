import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import Icon from '../Icon';

describe('Icon', () => {
  it('render_WhenNameGiven_ShouldRenderDecorativeSvgGlyph', () => {
    // Arrange & Act: icons are decorative reinforcement (UI Standards §7) — the consuming control
    // carries the accessible name, so the svg itself must be hidden from assistive tech.
    render(<Icon name="bell" />);

    // Assert
    const svg = screen.getByTestId('icon-bell');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('render_WhenSizeGiven_ShouldSetWidthAndHeight', () => {
    // Arrange & Act
    render(<Icon name="search" size={16} />);

    // Assert
    const svg = screen.getByTestId('icon-search');
    expect(svg).toHaveAttribute('width', '16');
    expect(svg).toHaveAttribute('height', '16');
  });
});
