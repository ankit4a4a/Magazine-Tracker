// Run this ONCE to create the first admin login:  npm run seed
require("dotenv").config();
const bcrypt = require("bcryptjs");
const connectDB = require("./config/db");
const Admin = require("./models/Admin");

(async () => {
  await connectDB();

  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "admin123";

  const existing = await Admin.findOne({ username });
  if (existing) {
    console.log(`⚠️  Admin "${username}" already exists. Skipping.`);
    process.exit(0);
  }

  

  const passwordHash = await bcrypt.hash(password, 10);
  await Admin.create({ username, passwordHash });

  console.log(`✅ Admin created!  username: "${username}"  password: "${password}"`);
  console.log("   (Change ADMIN_PASSWORD in .env before running seed on a real server)");
  process.exit(0);
})();
