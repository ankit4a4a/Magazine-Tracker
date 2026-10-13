function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.redirect("/admin/login");
}

function requireUser(req, res, next) {
  if (req.session && req.session.isUser && req.session.userId) {
    return next();
  }
  return res.redirect("/login");
}



module.exports = { requireAdmin, requireUser };
