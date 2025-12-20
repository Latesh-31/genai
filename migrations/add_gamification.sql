-- Add gamification fields to users table
ALTER TABLE users ADD COLUMN total_xp INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN streak_days INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_lesson_date DATE DEFAULT NULL;
ALTER TABLE users ADD COLUMN badges_json JSON DEFAULT NULL;

-- Add lesson completion tracking
CREATE TABLE IF NOT EXISTS lesson_completions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  course_id INT NOT NULL,
  module_index INT NOT NULL,
  topic_index INT NOT NULL,
  xp_earned INT NOT NULL DEFAULT 100,
  completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lesson_completions_user (user_id),
  KEY idx_lesson_completions_course (course_id),
  KEY idx_lesson_completions_unique (user_id, course_id, module_index, topic_index),
  CONSTRAINT fk_lesson_completions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_lesson_completions_course FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
