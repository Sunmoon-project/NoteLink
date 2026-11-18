import { useState } from 'react';
import { View } from 'react-native';
import { Pressable } from '@/components/press';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import { Text } from '@/components/text';
import { Chip } from '@/components/ui';
import { C, ICON } from '@/theme';

type Category = { _id: string; name: string; parentId: string | null };

/** 고를 수 있는 분야: 큰 분야와 그 바로 아래 세부 분야 */
export function selectableInterestIds(categories: Category[]) {
  const top = new Set(categories.filter((c) => c.parentId == null).map((c) => c._id));
  return new Set(
    categories.filter((c) => c.parentId == null || top.has(c.parentId)).map((c) => c._id),
  );
}

/**
 * 관심 분야 고르기(가입 · 프로필 공용). 세부 분야가 있는 큰 분야는 눌러 펼치는 줄로 보여 주고,
 * 펼치면 「○○ 전체」(큰 분야 자체)와 세부 분야 칩이 나온다. 세부 분야가 없는 큰 분야는 칩 하나로 둔다.
 * 접혀 있어도 고른 개수를 줄에 보여 준다
 */
export function InterestPicker({
  categories,
  selected,
  onToggle,
  disabled,
}: {
  categories: Category[];
  selected: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const top = categories.filter((c) => c.parentId == null);
  const childrenOf = (id: string) => categories.filter((c) => c.parentId === id);
  const flat = top.filter((g) => childrenOf(g._id).length === 0);
  const groups = top.filter((g) => childrenOf(g._id).length > 0);
  const chip = (id: string, label: string) => (
    <Chip key={id} on={selected.includes(id)} disabled={disabled} onPress={() => onToggle(id)}>
      {label}
    </Chip>
  );
  return (
    <View>
      {flat.length > 0 && (
        <View className="mt-2 flex-row flex-wrap gap-2">
          {flat.map((g) => chip(g._id, g.name))}
        </View>
      )}
      {groups.map((g) => {
        const kids = childrenOf(g._id);
        const count = [g, ...kids].filter((c) => selected.includes(c._id)).length;
        const expanded = open === g._id;
        return (
          <View key={g._id} className="border-b border-line">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={`${g.name}${count ? `, ${count}개 골랐어요` : ''}`}
              onPress={() => setOpen(expanded ? null : g._id)}
              className="h-12 flex-row items-center"
            >
              <Text className="flex-1 text-body font-semibold text-ink">{g.name}</Text>
              {count > 0 && (
                <Text className="mr-2 text-caption font-semibold text-brand">{count}개</Text>
              )}
              {expanded ? (
                <ChevronDown size={ICON.sm} color={C.sub} />
              ) : (
                <ChevronRight size={ICON.sm} color={C.sub} />
              )}
            </Pressable>
            {expanded && (
              <View className="flex-row flex-wrap gap-2 pb-4">
                {chip(g._id, `${g.name} 전체`)}
                {kids.map((c) => chip(c._id, c.name))}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}
