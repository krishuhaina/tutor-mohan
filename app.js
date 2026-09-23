// Tutor Mohan - Login Logic - 100% Free - No payment
console.log("Tutor Mohan Loaded Free");
function loginNow(){
  var email = document.getElementById('email').value;
  if(!email){ alert("Enter email"); return; }
  document.getElementById('view-login').classList.add('hidden');
  document.getElementById('view-student').classList.remove('hidden');
  document.getElementById('s-name').innerText = email;
}
function logout(){
  document.getElementById('view-login').classList.remove('hidden');
  document.getElementById('view-student').classList.add('hidden');
}
