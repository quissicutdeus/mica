// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import ErrorBoundaryTestWrapper from './ErrorBoundaryTestWrapper.svelte';

describe('ErrorBoundary component', () => {
  it('renders children normally when no error occurs', () => {
    const { getByText } = render(ErrorBoundaryTestWrapper, {
      props: {
        appName: 'TestApp',
        shouldCrash: false
      }
    });

    expect(getByText('Normal Child Content')).toBeTruthy();
  });
});
