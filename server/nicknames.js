import { randomInt } from 'node:crypto';

const adjectives = [
  '悠闲', '开心', '安静', '活泼', '温柔', '勇敢',
  '机灵', '好奇', '快乐', '可爱', '认真', '害羞',
  '热情', '勤劳', '乐观', '沉稳', '自由', '灵巧',
  '友善', '调皮', '优雅', '淡定', '清新', '灿烂'
];
const nouns = [
  '小熊', '海豚', '小猫', '小狗', '小兔', '松鼠', '企鹅', '水獭',
  '熊猫', '狐狸', '考拉', '海豹', '小鹿', '刺猬', '仓鼠', '树懒',
  '草莓', '苹果', '香蕉', '葡萄', '西瓜', '蜜桃', '樱桃', '柠檬',
  '芒果', '菠萝', '蓝莓', '橙子', '荔枝', '柚子', '石榴', '山竹'
];
const combinations = adjectives.flatMap(adjective => nouns.map(noun => `${adjective}的${noun}`));

export function createNickname(used) {
  const available = combinations.filter(name => !used.has(name));
  const nickname = available.length
    ? available[randomInt(available.length)]
    : `${combinations[randomInt(combinations.length)]}${used.size + 1}`;
  used.add(nickname);
  return nickname;
}
