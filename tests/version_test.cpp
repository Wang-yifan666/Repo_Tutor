#include <repo_tutor/version.hpp>

#include <cassert>
#include <cstring>

int main()
{
	assert(repo_tutor::kVersionMajor == 0);
	assert(repo_tutor::kVersionMinor == 1);
	assert(repo_tutor::kVersionPatch == 0);
	assert(std::strcmp(repo_tutor::kVersionString, "0.1.0") == 0);
	assert(std::strcmp(repo_tutor::version_string(), "0.1.0") == 0);
	return 0;
}
