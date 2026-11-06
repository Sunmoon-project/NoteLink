/** 아바타 스타일 (p.83 #26 · #27). 화면과 기기 저장 모드의 프로필 얼굴이 같이 쓴다 */
export const AV_STYLES = [
  {
    id: 'nice',
    name: 'Nice Avatar',
    sub: '2D 플랫 스타일',
    face: '👩🏻',
    maleFace: '👨🏻',
    bg: '#f6e3d8',
  },
  {
    id: '3d',
    name: '3D Avatar Creator',
    sub: '3D 리얼리즘',
    face: '👩🏽',
    maleFace: '👨🏽',
    bg: '#d9dcd6',
  },
  { id: 'toon', name: 'Cartoon 3D', sub: '3D 카툰', face: '👩🏼‍🦱', maleFace: '👨🏼‍🦱', bg: '#f3e6d6' },
];

/** 저장한 스타일 · 성별에 맞는 얼굴 (Avatar가 이모지를 얼굴로 그린다) */
export const avatarFace = (style: string, gender: 'male' | 'female') => {
  const s = AV_STYLES.find((x) => x.id === style) ?? AV_STYLES[1]!;
  return gender === 'male' ? s.maleFace : s.face;
};
