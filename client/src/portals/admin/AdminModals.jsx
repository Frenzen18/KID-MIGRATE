import AddUserModal from './modals/AddUserModal.jsx';
import EditUserModal from './modals/EditUserModal.jsx';
import DeleteUserModal from './modals/DeleteUserModal.jsx';
import EditClientModal from './modals/EditClientModal.jsx';
import EditDevelopmentalInfoModal from './modals/EditDevelopmentalInfoModal.jsx';
import ManageDevFunctionalFieldsModal from './modals/ManageDevFunctionalFieldsModal.jsx';
import LogProgressNoteModal from './modals/LogProgressNoteModal.jsx';
import DeleteClientModal from './modals/DeleteClientModal.jsx';
import EditShiftModal from './modals/EditShiftModal.jsx';
import CmsEditArticleModal from './modals/CmsEditArticleModal.jsx';
import CmsEditAnnouncementModal from './modals/CmsEditAnnouncementModal.jsx';
import CmsDeleteModal from './modals/CmsDeleteModal.jsx';
import AddClientModal from './modals/AddClientModal.jsx';
import RefundModal from './modals/RefundModal.jsx';
import AssignTherapistModal from './modals/AssignTherapistModal.jsx';

/**
 * Shared modal dispatcher, used by both AdminPortal and StaffPortal so the
 * two roles get identical, real behavior for every action they're both
 * allowed to take (the backend itself gates anything role-specific).
 *
 * Each modal "kind" now lives in its own file under ./modals, this file is
 * just a dispatch table mapping modal.id -> component, keeping the previous
 * single 1000+ line file split into one small, self-contained file per modal.
 */
const MODAL_COMPONENTS = {
  'add-user': AddUserModal,
  'edit-user': EditUserModal,
  'delete-user': DeleteUserModal,
  'edit-client': EditClientModal,
  'edit-developmental-info': EditDevelopmentalInfoModal,
  'manage-dev-functional-fields': ManageDevFunctionalFieldsModal,
  'log-progress-note': LogProgressNoteModal,
  'delete-client': DeleteClientModal,
  'edit-shift': EditShiftModal,
  'cms-edit-article': CmsEditArticleModal,
  'cms-edit': CmsEditArticleModal,
  'cms-edit-announcement': CmsEditAnnouncementModal,
  'cms-delete': CmsDeleteModal,
  'add-client': AddClientModal,
  'refund': RefundModal,
  'assign-therapist': AssignTherapistModal,
};

export default function AdminModals({ modal, closeModal, toast }) {
  if (!modal) return null;
  const Component = MODAL_COMPONENTS[modal.id];
  if (!Component) return null;
  return <Component data={modal.data || {}} closeModal={closeModal} toast={toast} />;
}
