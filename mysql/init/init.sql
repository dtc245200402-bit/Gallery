SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS albums (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NULL,
  category VARCHAR(60) NOT NULL DEFAULT 'Khác',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_albums_category (category),
  INDEX idx_albums_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS photos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  album_id BIGINT UNSIGNED NOT NULL,
  filename VARCHAR(80) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(40) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT 'Khác',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_photos_filename (filename),
  INDEX idx_photos_album_created (album_id, created_at),
  CONSTRAINT fk_photos_album FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS album_shares (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  album_id BIGINT UNSIGNED NOT NULL,
  token CHAR(64) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_album_shares_album (album_id),
  UNIQUE KEY uq_album_shares_token (token),
  CONSTRAINT fk_shares_album FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS photo_shares (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  photo_id BIGINT UNSIGNED NOT NULL,
  token CHAR(64) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_photo_shares_photo (photo_id),
  UNIQUE KEY uq_photo_shares_token (token),
  CONSTRAINT fk_shares_photo FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(120) NOT NULL,
  password_hash VARCHAR(180) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) NOT NULL,
  expires INT UNSIGNED NOT NULL,
  data MEDIUMTEXT NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (session_id),
  INDEX idx_sessions_expires (expires),
  INDEX idx_sessions_user_id (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS customers (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS contacts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  role VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_contacts_customer (customer_id),
  CONSTRAINT fk_contacts_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO albums (name, description, category)
SELECT 'Du lịch Đà Lạt', 'Khoảnh khắc trong chuyến đi Đà Lạt.', 'Du lịch'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM albums WHERE name = 'Du lịch Đà Lạt');

INSERT INTO albums (name, description, category)
SELECT 'Gia đình thân yêu', 'Ảnh lưu giữ những khoảnh khắc gia đình.', 'Gia đình'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM albums WHERE name = 'Gia đình thân yêu');

INSERT INTO albums (name, description, category)
SELECT 'Thiên nhiên Việt Nam', 'Phong cảnh và thiên nhiên Việt Nam.', 'Thiên nhiên'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM albums WHERE name = 'Thiên nhiên Việt Nam');

INSERT INTO albums (name, description, category)
SELECT 'Ẩm thực yêu thích', 'Những món ăn và trải nghiệm ẩm thực.', 'Ẩm thực'
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM albums WHERE name = 'Ẩm thực yêu thích');

