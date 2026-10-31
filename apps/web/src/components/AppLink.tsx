import type { ComponentProps } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { pageOf } from '../lib/nav';

/**
 * A link that only links where the person may go: if the target belongs to a menu page taken out of their menu (by
 * role or by person, under Security → Menu access) or needs a permission they lack, the text shows without a link. Use it for every in-app link.
 */
export function Link({ to, children, className, ...rest }: ComponentProps<typeof RouterLink>) {
  const { sees, can } = useAuth();
  const path = typeof to === 'string' ? to.split(/[?#]/)[0]! : to.pathname ?? '';
  const page = path.startsWith('/') ? pageOf(path) : null;
  if (page && (!sees(page.to) || (page.perms && !can(...page.perms)))) return <span className={typeof className === 'string' ? className?.replace(/\blink\b/, '') : undefined}>{children}</span>;
  return <RouterLink to={to} className={className} {...rest}>{children}</RouterLink>;
}
