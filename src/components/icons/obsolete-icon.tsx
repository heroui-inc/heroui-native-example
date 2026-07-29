import React from 'react';
import Svg, { Path } from 'react-native-svg';

import type { IconProps } from '../../helpers/types/icons';

/**
 * Local-only icon that does not exist in the upstream example app.
 * Seeded to verify that the release sync deletes files upstream no longer ships.
 */
export const ObsoleteIcon: React.FC<IconProps> = ({ size = 24, ...props }) => {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...props}>
      <Path d="M4 4L20 20M20 4L4 20" stroke="currentColor" strokeWidth={2} />
    </Svg>
  );
};
